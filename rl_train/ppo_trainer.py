import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import TensorDataset, DataLoader
import numpy as np
from collections import deque
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional
from pathlib import Path
import json
import time

from .policy import PolicyNetwork, RLTradingAgent


@dataclass
class PPOTrajectory:
    states: List[np.ndarray] = field(default_factory=list)
    actions: List[int] = field(default_factory=list)
    rewards: List[float] = field(default_factory=list)
    log_probs: List[float] = field(default_factory=list)
    values: List[float] = field(default_factory=list)
    dones: List[bool] = field(default_factory=list)
    
    def to_tensors(self, device: torch.device) -> Tuple[torch.Tensor, ...]:
        states = torch.FloatTensor(np.array(self.states)).to(device)
        actions = torch.LongTensor(np.array(self.actions)).to(device)
        rewards = torch.FloatTensor(np.array(self.rewards)).to(device)
        old_log_probs = torch.FloatTensor(np.array(self.log_probs)).to(device)
        values = torch.FloatTensor(np.array(self.values)).to(device)
        dones = torch.FloatTensor(np.array(self.dones, dtype=np.float32)).to(device)
        return states, actions, rewards, old_log_probs, values, dones


@dataclass
class TrainingStats:
    episode: int = 0
    episode_return: float = 0.0
    max_drawdown: float = 0.0
    episode_length: int = 0
    policy_loss: float = 0.0
    value_loss: float = 0.0
    entropy: float = 0.0
    learning_rate: float = 0.0
    total_steps: int = 0


@dataclass
class PPOHyperparameters:
    gamma: float = 0.99
    epsilon: float = 0.2
    value_coef: float = 0.5
    entropy_coef: float = 0.01
    max_grad_norm: float = 0.5
    num_epochs: int = 10
    batch_size: int = 64
    clip_frac_history_size: int = 100
    target_kl: float = 0.01


class PPOTrainer:
    def __init__(
        self,
        agent: RLTradingAgent,
        hyperparameters: PPOHyperparameters = None,
        normalize_rewards: bool = True,
        value_clip: bool = True,
    ):
        self.agent = agent
        self.hyperparams = hyperparameters or PPOHyperparameters()
        self.normalize_rewards = normalize_rewards
        self.value_clip = value_clip
        
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.policy = agent.policy
        self.optimizer = self.policy.optimizer
        
        self.trajectory = PPOTrajectory()
        self.gae = GAE(self.hyperparams.gamma, 0.95)
        
        self.stats_history: List[TrainingStats] = []
        self.clip_frac_history = deque(maxlen=self.hyperparams.clip_frac_history_size)
        
        self.best_return = -float('inf')
        self.best_model_path = Path("./rl_train/best_model.pt")
        self.checkpoint_path = Path("./rl_train/checkpoint.pt")
        
        self._current_stats = TrainingStats()
    
    def add_experience(
        self,
        state: np.ndarray,
        action: int,
        reward: float,
        log_prob: float,
        value: float,
        done: bool,
    ):
        self.trajectory.states.append(state)
        self.trajectory.actions.append(action)
        self.trajectory.rewards.append(reward)
        self.trajectory.log_probs.append(log_prob)
        self.trajectory.values.append(value)
        self.trajectory.dones.append(done)
    
    def compute_returns_and_advantages(
        self,
        rewards: torch.Tensor,
        values: torch.Tensor,
        dones: torch.Tensor,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        advantages = self.gae.compute(rewards, values, dones)
        
        returns = advantages + values.detach()
        
        if self.normalize_rewards and len(advantages) > 1:
            advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)
        
        return returns.detach(), advantages.detach()
    
    def update(self) -> Dict[str, float]:
        if len(self.trajectory.states) == 0:
            return {}
        
        states, actions, rewards, old_log_probs, values, dones = \
            self.trajectory.to_tensors(self.device)
        
        returns, advantages = self.compute_returns_and_advantages(
            rewards, values, dones
        )
        
        dataset = TensorDataset(states, actions, old_log_probs, returns, advantages)
        dataloader = DataLoader(
            dataset,
            batch_size=self.hyperparams.batch_size,
            shuffle=True,
        )
        
        total_policy_loss = 0.0
        total_value_loss = 0.0
        total_entropy = 0.0
        total_kl = 0.0
        num_updates = 0
        
        for epoch in range(self.hyperparams.num_epochs):
            for batch in dataloader:
                batch_states, batch_actions, batch_old_log_probs, batch_returns, batch_advantages = batch
                
                log_probs, values_pred, entropy = self.policy.evaluate_actions(
                    batch_states, batch_actions
                )
                
                ratio = torch.exp(log_probs - batch_old_log_probs)
                
                surr1 = ratio * batch_advantages
                surr2 = torch.clamp(
                    ratio,
                    1.0 - self.hyperparams.epsilon,
                    1.0 + self.hyperparams.epsilon,
                ) * batch_advantages
                
                policy_loss = -torch.min(surr1, surr2).mean()
                
                if self.value_clip:
                    values_clipped = batch_returns + torch.clamp(
                        values_pred - batch_returns,
                        -self.hyperparams.epsilon,
                        self.hyperparams.epsilon,
                    )
                    value_loss1 = (values_pred - batch_returns).pow(2)
                    value_loss2 = (values_clipped - batch_returns).pow(2)
                    value_loss = 0.5 * torch.max(value_loss1, value_loss2).mean()
                else:
                    value_loss = 0.5 * (values_pred - batch_returns).pow(2).mean()
                
                entropy_loss = -entropy.mean()
                
                loss = (
                    policy_loss +
                    self.hyperparams.value_coef * value_loss +
                    self.hyperparams.entropy_coef * entropy_loss
                )
                
                self.optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(
                    self.policy.parameters(),
                    self.hyperparams.max_grad_norm
                )
                self.optimizer.step()
                
                with torch.no_grad():
                    kl = (batch_old_log_probs - log_probs).mean()
                
                total_policy_loss += policy_loss.item()
                total_value_loss += value_loss.item()
                total_entropy += entropy.mean().item()
                total_kl += kl.item()
                num_updates += 1
        
        avg_policy_loss = total_policy_loss / max(num_updates, 1)
        avg_value_loss = total_value_loss / max(num_updates, 1)
        avg_entropy = total_entropy / max(num_updates, 1)
        avg_kl = total_kl / max(num_updates, 1)
        
        with torch.no_grad():
            ratios = torch.exp(log_probs - batch_old_log_probs)
            clipped = ((ratios > 1 + self.hyperparams.epsilon) | (ratios < 1 - self.hyperparams.epsilon)).float()
            clip_frac = float(clipped.mean().item())
        self.clip_frac_history.append(clip_frac)
        
        self._current_stats.policy_loss = avg_policy_loss
        self._current_stats.value_loss = avg_value_loss
        self._current_stats.entropy = avg_entropy
        
        self.trajectory = PPOTrajectory()
        
        return {
            'policy_loss': avg_policy_loss,
            'value_loss': avg_value_loss,
            'entropy': avg_entropy,
            'kl_divergence': avg_kl,
            'clip_fraction': clip_frac,
        }
    
    def record_episode_stats(
        self,
        episode: int,
        episode_return: float,
        max_drawdown: float,
        episode_length: int,
    ):
        self._current_stats.episode = episode
        self._current_stats.episode_return = episode_return
        self._current_stats.max_drawdown = max_drawdown
        self._current_stats.episode_length = episode_length
        self._current_stats.learning_rate = self.optimizer.param_groups[0]['lr']
        self._current_stats.total_steps += episode_length
        
        self.stats_history.append(self._current_stats)
        
        if episode_return > self.best_return:
            self.best_return = episode_return
            self.save(self.best_model_path)
            print(f"  New best model saved! Return: {episode_return:.2f}")
        
        self._current_stats = TrainingStats()
    
    def save(self, filepath: Path):
        filepath.parent.mkdir(parents=True, exist_ok=True)
        
        torch.save({
            'policy_state_dict': self.policy.state_dict(),
            'optimizer_state_dict': self.optimizer.state_dict(),
            'best_return': self.best_return,
            'stats_history': [
                {
                    'episode': s.episode,
                    'episode_return': s.episode_return,
                    'max_drawdown': s.max_drawdown,
                    'episode_length': s.episode_length,
                    'policy_loss': s.policy_loss,
                    'value_loss': s.value_loss,
                    'entropy': s.entropy,
                }
                for s in self.stats_history[-1000:]
            ],
        }, filepath)
    
    def load(self, filepath: Path):
        checkpoint = torch.load(filepath, map_location=self.device)
        self.policy.load_state_dict(checkpoint['policy_state_dict'])
        self.optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
        self.best_return = checkpoint.get('best_return', -float('inf'))
        print(f"Loaded model from {filepath}. Best return: {self.best_return:.2f}")
    
    def save_stats(self, filepath: Path = None):
        if filepath is None:
            filepath = Path("./rl_train/training_stats.json")
        filepath.parent.mkdir(parents=True, exist_ok=True)
        
        stats_data = {
            'hyperparameters': {
                'gamma': self.hyperparams.gamma,
                'epsilon': self.hyperparams.epsilon,
                'value_coef': self.hyperparams.value_coef,
                'entropy_coef': self.hyperparams.entropy_coef,
                'num_epochs': self.hyperparams.num_epochs,
                'batch_size': self.hyperparams.batch_size,
            },
            'stats': [
                {
                    'episode': s.episode,
                    'episode_return': s.episode_return,
                    'max_drawdown': s.max_drawdown,
                    'episode_length': s.episode_length,
                    'policy_loss': s.policy_loss,
                    'value_loss': s.value_loss,
                    'entropy': s.entropy,
                    'learning_rate': s.learning_rate,
                    'total_steps': s.total_steps,
                }
                for s in self.stats_history
            ],
            'best_return': self.best_return,
        }
        
        with open(filepath, 'w') as f:
            json.dump(stats_data, f, indent=2)
        
        print(f"Saved training stats to {filepath}")


class GAE:
    def __init__(self, gamma: float = 0.99, lambda_: float = 0.95):
        self.gamma = gamma
        self.lambda_ = lambda_
    
    def compute(
        self,
        rewards: torch.Tensor,
        values: torch.Tensor,
        dones: torch.Tensor,
    ) -> torch.Tensor:
        advantages = torch.zeros_like(rewards)
        gae = 0
        
        for t in reversed(range(len(rewards))):
            if t == len(rewards) - 1:
                next_value = 0
            else:
                next_value = values[t + 1]
            
            delta = rewards[t] + self.gamma * next_value * (1 - dones[t]) - values[t]
            gae = delta + self.gamma * self.lambda_ * (1 - dones[t]) * gae
            advantages[t] = gae
        
        return advantages


class LearningRateScheduler:
    def __init__(
        self,
        optimizer,
        initial_lr: float = 3e-4,
        min_lr: float = 1e-5,
        decay_rate: float = 0.95,
        decay_steps: int = 100,
    ):
        self.optimizer = optimizer
        self.initial_lr = initial_lr
        self.min_lr = min_lr
        self.decay_rate = decay_rate
        self.decay_steps = decay_steps
        self.current_step = 0
    
    def step(self):
        self.current_step += 1
        
        if self.current_step % self.decay_steps == 0:
            new_lr = max(
                self.initial_lr * (self.decay_rate ** (self.current_step // self.decay_steps)),
                self.min_lr,
            )
            
            for param_group in self.optimizer.param_groups:
                param_group['lr'] = new_lr
            
            print(f"  Learning rate decayed to: {new_lr:.2e}")
    
    def get_lr(self) -> float:
        return self.optimizer.param_groups[0]['lr']
