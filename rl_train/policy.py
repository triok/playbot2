import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.distributions import Categorical
import numpy as np
from typing import Tuple, Optional


class PolicyNetwork(nn.Module):
    def __init__(
        self,
        state_dim: int = 32,
        action_dim: int = 7,
        hidden_dims: Tuple[int, int, int] = (128, 128, 64),
        learning_rate: float = 3e-4,
    ):
        super().__init__()
        
        self.action_dim = action_dim
        
        layers = []
        prev_dim = state_dim
        
        for hidden_dim in hidden_dims:
            layers.extend([
                nn.Linear(prev_dim, hidden_dim),
                nn.ReLU(),
                nn.LayerNorm(hidden_dim),
            ])
            prev_dim = hidden_dim
        
        self.shared_net = nn.Sequential(*layers)
        
        self.actor = nn.Linear(prev_dim, action_dim)
        self.critic = nn.Sequential(
            nn.Linear(prev_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 1)
        )
        
        self.optimizer = torch.optim.Adam(self.parameters(), lr=learning_rate)
        
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.to(self.device)
    
    def forward(self, state: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        x = self.shared_net(state)
        logits = self.actor(x)
        value = self.critic(x)
        return logits, value
    
    def get_action(self, state: np.ndarray, deterministic: bool = False) -> Tuple[int, float, float]:
        state_tensor = torch.FloatTensor(state).to(self.device)
        
        with torch.no_grad():
            logits, value = self.forward(state_tensor)
            probs = F.softmax(logits, dim=-1)
            
            if deterministic:
                action = torch.argmax(probs).item()
            else:
                dist = Categorical(probs)
                action = dist.sample().item()
            
            log_prob = torch.log(probs[action] + 1e-8)
            
        return action, log_prob.item(), value.item()
    
    def evaluate_actions(
        self,
        states: torch.Tensor,
        actions: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        logits, values = self.forward(states)
        probs = F.softmax(logits, dim=-1)
        
        dist = Categorical(probs)
        log_probs = dist.log_prob(actions)
        entropy = dist.entropy()
        
        return log_probs, values.squeeze(-1), entropy
    
    def save(self, filepath: str):
        torch.save({
            'policy_state_dict': self.state_dict(),
            'optimizer_state_dict': self.optimizer.state_dict(),
        }, filepath)
        print(f"Saved policy to {filepath}")
    
    def load(self, filepath: str):
        checkpoint = torch.load(filepath, map_location=self.device)
        if 'policy_state_dict' in checkpoint:
            self.load_state_dict(checkpoint['policy_state_dict'])
        elif 'model_state_dict' in checkpoint:
            self.load_state_dict(checkpoint['model_state_dict'])
        if 'optimizer_state_dict' in checkpoint:
            self.optimizer.load_state_dict(checkpoint['optimizer_state_dict'])
        print(f"Loaded policy from {filepath}")


class BaselineStrategy:
    def __init__(self):
        self.name = "Baseline"
    
    def get_action(self, state: np.ndarray) -> int:
        phase_idx = 14
        pnl_idx = 13
        
        if len(state) <= max(phase_idx, pnl_idx):
            return 0
        
        phase = state[phase_idx]
        pnl = state[pnl_idx] if len(state) > pnl_idx else 0
        
        if phase == 1.0:
            return 0
        
        if state[4] > 0.05:
            return 3
        
        if state[0] < 0.5:
            return 2
        
        return 0


class RandomStrategy:
    def __init__(self, action_dim: int = 7):
        self.action_dim = action_dim
    
    def get_action(self, state: np.ndarray) -> int:
        return np.random.randint(0, self.action_dim)


class RLTradingAgent:
    def __init__(
        self,
        state_dim: int = 32,
        action_dim: int = 7,
        hidden_dims: Tuple[int, int, int] = (128, 128, 64),
        learning_rate: float = 3e-4,
    ):
        self.policy = PolicyNetwork(
            state_dim=state_dim,
            action_dim=action_dim,
            hidden_dims=hidden_dims,
            learning_rate=learning_rate,
        )
        self.baseline = BaselineStrategy()
        self.random = RandomStrategy(action_dim)
    
    def select_action(
        self,
        state: np.ndarray,
        strategy: str = "rl",
        deterministic: bool = False,
    ) -> Tuple[int, float, float]:
        if strategy == "rl":
            return self.policy.get_action(state, deterministic=deterministic)
        elif strategy == "baseline":
            return self.baseline.get_action(state), 0.0, 0.0
        elif strategy == "random":
            return self.random.get_action(state), 0.0, 0.0
        else:
            raise ValueError(f"Unknown strategy: {strategy}")
    
    def update(self, *args, **kwargs):
        return self.policy.update(*args, **kwargs)
    
    def save(self, filepath: str):
        self.policy.save(filepath)
    
    def load(self, filepath: str):
        self.policy.load(filepath)
