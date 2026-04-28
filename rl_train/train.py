import sys
sys.path.insert(0, '.')

import argparse
import numpy as np
from pathlib import Path
import time
import json

from rl_train.environment import create_env, load_market_features, MarketFeatures, PolymarketEnv
from rl_train.policy import RLTradingAgent
from rl_train.ppo_trainer import PPOTrainer, PPOHyperparameters, LearningRateScheduler


def run_training(
    num_episodes: int = 10000,
    update_interval: int = 128,
    log_interval: int = 50,
    save_interval: int = 500,
    checkpoint_interval: int = 1000,
    llm_review_interval: int = 50,
    compare_baselines: bool = True,
    device: str = "auto",
):
    print("=" * 70)
    print("Polymarket RL Trading Agent - Training")
    print("=" * 70)
    
    print("\n[1/5] Loading market features...")
    try:
        market_features = load_market_features("./rl_analytics/market_features.json")
    except FileNotFoundError:
        print("ERROR: Market features not found!")
        print("Please run feature extraction first:")
        print("  python -m services.rl_agent.features")
        return
    
    print(f"  Loaded {len(market_features)} markets")
    
    print("\n[2/5] Creating environment...")
    env = create_env(
        market_features=market_features,
        max_episode_steps=900,
        initial_balance=1000.0,
        budget_per_trade=25.0,  # Reduced from 190 to limit max loss
        max_drawdown=-60.0,
        safety_stop_threshold=-40.0,
        max_loss_per_market=10.0,  # NEW: Max $10 loss per market
    )
    
    print("\n[3/5] Initializing RL agent...")
    hyperparameters = PPOHyperparameters(
        gamma=0.99,
        epsilon=0.2,
        value_coef=0.5,
        entropy_coef=0.01,
        num_epochs=10,
        batch_size=64,
    )
    
    agent = RLTradingAgent(
        state_dim=32,
        action_dim=7,
        hidden_dims=(128, 128, 64),
        learning_rate=3e-4,
    )
    
    trainer = PPOTrainer(
        agent=agent,
        hyperparameters=hyperparameters,
        normalize_rewards=True,
        value_clip=True,
    )
    
    lr_scheduler = LearningRateScheduler(
        trainer.optimizer,
        initial_lr=3e-4,
        min_lr=1e-5,
        decay_rate=0.95,
        decay_steps=1000,
    )
    
    print("\n[4/5] Starting training...")
    print(f"  Target episodes: {num_episodes}")
    print(f"  Update interval: {update_interval}")
    print(f"  Max drawdown constraint: -$60")
    print()
    
    episode_returns = []
    baseline_returns = []
    random_returns = []
    
    for episode in range(1, num_episodes + 1):
        state, _ = env.reset()
        episode_return = 0
        episode_max_drawdown = 0
        episode_length = 0
        
        terminated = False
        truncated = False
        
        while not (terminated or truncated):
            action, log_prob, value = agent.select_action(state, strategy="rl")
            
            next_state, reward, terminated, truncated, info = env.step(action)
            
            trainer.add_experience(
                state=state,
                action=action,
                reward=reward,
                log_prob=log_prob,
                value=value,
                done=terminated,
            )
            
            state = next_state
            episode_return += reward
            episode_max_drawdown = min(episode_max_drawdown, info.get('max_drawdown', 0))
            episode_length += 1
            
            if len(trainer.trajectory.states) >= update_interval:
                update_stats = trainer.update()
                lr_scheduler.step()
        
        trainer.record_episode_stats(
            episode=episode,
            episode_return=episode_return,
            max_drawdown=episode_max_drawdown,
            episode_length=episode_length,
        )
        
        episode_returns.append(episode_return)
        
        if compare_baselines and episode % log_interval == 0:
            _, baseline_return, _ = agent.select_action(state, strategy="baseline")
            _, random_return, _ = agent.select_action(state, strategy="random")
            baseline_returns.append(baseline_return)
            random_returns.append(random_return)
        
        if episode % log_interval == 0:
            recent_returns = episode_returns[-log_interval:]
            avg_return = np.mean(recent_returns)
            std_return = np.std(recent_returns)
            
            drawdowns = [s.max_drawdown for s in trainer.stats_history[-log_interval:]]
            avg_drawdown = np.mean(drawdowns) if drawdowns else 0
            
            constraint_met = all(dd >= -60 for dd in drawdowns)
            constraint_str = "OK" if constraint_met else "VIOLATED"
            
            print(f"Episode {episode:5d} | "
                  f"Return: {avg_return:7.2f} ± {std_return:6.2f} | "
                  f"Max DD: {avg_drawdown:6.2f} | "
                  f"Constraint: {constraint_str}")
        
        if episode % save_interval == 0:
            trainer.save(Path(f"./rl_train/models/episode_{episode}.pt"))
            trainer.save_stats()
        
        if episode % checkpoint_interval == 0:
            trainer.save(trainer.checkpoint_path)
    
    print("\n[5/5] Training complete!")
    print("=" * 70)
    
    recent_100 = episode_returns[-100:]
    avg_return_100 = np.mean(recent_100)
    std_return_100 = np.std(recent_100)
    max_drawdown_100 = min([s.max_drawdown for s in trainer.stats_history[-100:]])
    
    print("\nFinal Statistics (last 100 episodes):")
    print(f"  Average Return:     ${avg_return_100:.2f} ± ${std_return_100:.2f}")
    print(f"  Max Drawdown:      ${max_drawdown_100:.2f}")
    print(f"  Constraint (-$60): {'MET' if max_drawdown_100 >= -60 else 'VIOLATED'}")
    
    if compare_baselines and baseline_returns:
        print("\nComparison with Baselines:")
        print(f"  RL Agent:          ${avg_return_100:.2f}")
        print(f"  Baseline Strategy:  ${np.mean(baseline_returns[-10:]):.2f}")
        print(f"  Random Strategy:   ${np.mean(random_returns[-10:]):.2f}")
    
    trainer.save(Path("./rl_train/final_model.pt"))
    trainer.save_stats()
    
    return trainer, episode_returns


def run_evaluation(agent: RLTradingAgent, env: PolymarketEnv, num_episodes: int = 100):
    print("\n" + "=" * 70)
    print("Evaluation Mode")
    print("=" * 70)
    
    returns = []
    drawdowns = []
    
    for episode in range(1, num_episodes + 1):
        state, _ = env.reset()
        episode_return = 0
        max_drawdown = 0
        
        terminated = False
        truncated = False
        
        while not (terminated or truncated):
            action, _, _ = agent.select_action(state, strategy="rl", deterministic=True)
            state, reward, terminated, truncated, info = env.step(action)
            episode_return += reward
            max_drawdown = min(max_drawdown, info.get('max_drawdown', 0))
        
        returns.append(episode_return)
        drawdowns.append(max_drawdown)
        
        if episode % 10 == 0:
            print(f"Episode {episode}: Return=${episode_return:.2f}, Max DD=${max_drawdown:.2f}")
    
    print("\nEvaluation Results:")
    print(f"  Mean Return:    ${np.mean(returns):.2f} ± ${np.std(returns):.2f}")
    print(f"  Mean Drawdown:  ${np.mean(drawdowns):.2f}")
    print(f"  Max Drawdown:   ${min(drawdowns):.2f}")
    print(f"  Constraint Met: {all(d >= -60 for d in drawdowns)}")
    
    return returns, drawdowns


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train RL agent for Polymarket trading")
    parser.add_argument("--episodes", type=int, default=10000, help="Number of training episodes")
    parser.add_argument("--update-interval", type=int, default=128, help="Steps between updates")
    parser.add_argument("--log-interval", type=int, default=50, help="Episodes between logs")
    parser.add_argument("--save-interval", type=int, default=500, help="Episodes between saves")
    parser.add_argument("--no-baselines", action="store_true", help="Skip baseline comparison")
    parser.add_argument("--resume", type=str, help="Resume from checkpoint")
    
    args = parser.parse_args()
    
    if args.resume:
        print(f"Resuming from {args.resume}")
        agent = RLTradingAgent(state_dim=32, action_dim=7)
        trainer = PPOTrainer(agent=agent)
        trainer.load(Path(args.resume))
    else:
        trainer, returns = run_training(
            num_episodes=args.episodes,
            update_interval=args.update_interval,
            log_interval=args.log_interval,
            save_interval=args.save_interval,
            compare_baselines=not args.no_baselines,
        )
