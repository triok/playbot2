import json
import os
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Optional, Any
from datetime import datetime
import hashlib


@dataclass
class StrategyReview:
    timestamp: str
    episode: int
    total_episodes: int
    training_stats: Dict[str, float]
    performance_metrics: Dict[str, float]
    recommendations: List[str]
    strategy_changes: List[Dict[str, Any]]
    token_budget_used: int
    review_type: str


@dataclass
class LLMReviewerConfig:
    api_key: Optional[str] = None
    model: str = "gpt-4"
    temperature: float = 0.7
    max_tokens: int = 2000
    token_budget_per_review: int = 1500
    review_interval: int = 50
    min_episodes_before_review: int = 100


class StrategyReviewer:
    def __init__(
        self,
        config: LLMReviewerConfig = None,
        output_dir: str = "./rl_analytics/strategy_reviews",
    ):
        self.config = config or LLMReviewerConfig()
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.review_history: List[StrategyReview] = []
        self.total_tokens_used = 0
        self._api_key = self.config.api_key or os.environ.get("OPENAI_API_KEY")
    
    def should_review(self, episode: int, force: bool = False) -> bool:
        if not force and episode < self.config.min_episodes_before_review:
            return False
        
        if episode % self.config.review_interval != 0:
            return False
        
        estimated_tokens = self._estimate_tokens_for_review(episode)
        remaining_budget = self.config.token_budget_per_review - estimated_tokens
        
        return remaining_budget >= 0
    
    def _estimate_tokens_for_review(self, episode: int) -> int:
        return min(episode // 10, 500)
    
    def analyze_performance(
        self,
        stats_history: List[Dict],
        episode: int,
    ) -> Dict[str, float]:
        recent_50 = stats_history[-50:] if len(stats_history) >= 50 else stats_history
        recent_100 = stats_history[-100:] if len(stats_history) >= 100 else recent_50
        
        if not recent_50:
            return {
                'avg_return': 0.0,
                'return_trend': 0.0,
                'max_drawdown': 0.0,
                'volatility': 0.0,
                'win_rate': 0.0,
            }
        
        returns = [s.get('episode_return', 0) for s in recent_100]
        drawdowns = [abs(s.get('max_drawdown', 0)) for s in recent_100]
        
        wins = sum(1 for r in returns if r > 0)
        
        return {
            'avg_return': float(sum(returns) / len(returns)),
            'return_std': float((sum((r - sum(returns)/len(returns))**2 for r in returns) / len(returns)) ** 0.5),
            'return_trend': float(self._calculate_trend(returns)),
            'max_drawdown': float(min(drawdowns) if drawdowns else 0),
            'avg_drawdown': float(sum(drawdowns) / len(drawdowns)),
            'win_rate': float(wins / len(returns)) if returns else 0.0,
            'episodes_reviewed': len(recent_100),
        }
    
    def _calculate_trend(self, values: List[float]) -> float:
        if len(values) < 2:
            return 0.0
        
        n = len(values)
        x_mean = (n - 1) / 2
        y_mean = sum(values) / n
        
        numerator = sum((i - x_mean) * (values[i] - y_mean) for i in range(n))
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        
        if denominator == 0:
            return 0.0
        
        slope = numerator / denominator
        return slope
    
    def generate_review_prompt(
        self,
        episode: int,
        total_episodes: int,
        performance: Dict[str, float],
        recent_actions: List[Dict] = None,
    ) -> str:
        progress_pct = (episode / total_episodes) * 100
        
        prompt = f"""You are reviewing an RL trading agent's performance after {episode} episodes ({progress_pct:.1f}% of training).

## Current Performance Metrics:
- Average Return: ${performance.get('avg_return', 0):.2f}
- Return Volatility: ${performance.get('return_std', 0):.2f}
- Return Trend: {performance.get('return_trend', 0):.4f}/episode
- Max Drawdown: ${performance.get('max_drawdown', 0):.2f}
- Average Drawdown: ${performance.get('avg_drawdown', 0):.2f}
- Win Rate: {performance.get('win_rate', 0)*100:.1f}%

## Hard Constraint:
Maximum portfolio drawdown MUST NOT exceed -$60.

## Current Strategy Phases:
1. P0: Already risk-free (stop)
2. P1: FOK order for immediate RF
3. P2: GTC on losing side
4. P3: Grid averaging ($1 per -10% price drop)
5. P4: Buy more of leading side (>= 0.62 threshold)
6. P5: Wait

## Action Space:
0: HOLD, 1: BUY_LOSER_FOK, 2: BUY_LOSER_GTC, 3: BUY_LEADER, 4: TRIGGER_GRID, 5: SELL_HALF, 6: CLOSE_POSITION

## Your Task:
1. Analyze if the agent is learning effectively
2. Check if the -$60 drawdown constraint is being respected
3. Suggest specific parameter adjustments or strategy modifications
4. Keep suggestions token-efficient (max 200 tokens output)

Respond in JSON format:
{{
    "analysis": "brief analysis of current performance",
    "constraint_status": "PASS/FAIL/WARNING",
    "recommendations": ["recommendation 1", "recommendation 2"],
    "strategy_changes": [
        {{"parameter": "entry_price", "current": 0.45, "suggested": 0.42, "reason": "..."}}
    ],
    "confidence": "HIGH/MEDIUM/LOW"
}}
"""
        return prompt
    
    async def review(
        self,
        episode: int,
        total_episodes: int,
        stats_history: List[Dict],
        recent_actions: List[Dict] = None,
    ) -> Optional[StrategyReview]:
        if not self.should_review(episode):
            return None
        
        performance = self.analyze_performance(stats_history, episode)
        prompt = self.generate_review_prompt(episode, total_episodes, performance, recent_actions)
        
        estimated_tokens = len(prompt.split()) * 1.3
        
        if self.total_tokens_used + estimated_tokens > self.config.token_budget_per_review * 10:
            print(f"Token budget nearly exhausted. Skipping review at episode {episode}.")
            return None
        
        review = None
        
        if self._api_key:
            try:
                review = await self._call_llm(prompt, episode, total_episodes, performance)
            except Exception as e:
                print(f"LLM review failed: {e}")
                review = self._generate_fallback_review(episode, total_episodes, performance)
        else:
            print("No API key found. Using fallback review (no LLM call).")
            review = self._generate_fallback_review(episode, total_episodes, performance)
        
        if review:
            self.review_history.append(review)
            self._save_review(review)
            self._print_review_summary(review)
        
        return review
    
    async def _call_llm(
        self,
        prompt: str,
        episode: int,
        total_episodes: int,
        performance: Dict[str, float],
    ) -> Optional[StrategyReview]:
        import openai
        
        client = openai.OpenAI(api_key=self._api_key)
        
        response = client.chat.completions.create(
            model=self.config.model,
            messages=[
                {"role": "system", "content": "You are a quantitative trading strategy reviewer."},
                {"role": "user", "content": prompt}
            ],
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
        )
        
        content = response.choices[0].message.content
        tokens_used = response.usage.total_tokens
        self.total_tokens_used += tokens_used
        
        try:
            if content.startswith("```json"):
                content = content[7:]
            if content.endswith("```"):
                content = content[:-3]
            
            review_data = json.loads(content.strip())
            
            return StrategyReview(
                timestamp=datetime.now().isoformat(),
                episode=episode,
                total_episodes=total_episodes,
                training_stats=performance,
                performance_metrics=review_data.get('performance_metrics', {}),
                recommendations=review_data.get('recommendations', []),
                strategy_changes=review_data.get('strategy_changes', []),
                token_budget_used=tokens_used,
                review_type="llm",
            )
        except json.JSONDecodeError:
            print("Failed to parse LLM response as JSON")
            return self._generate_fallback_review(episode, total_episodes, performance)
    
    def _generate_fallback_review(
        self,
        episode: int,
        total_episodes: int,
        performance: Dict[str, float],
    ) -> StrategyReview:
        recommendations = []
        strategy_changes = []
        
        if performance.get('max_drawdown', 0) > 50:
            recommendations.append("Consider reducing position sizes to better respect -$60 drawdown constraint")
            strategy_changes.append({
                "parameter": "budget_per_trade",
                "current": 190,
                "suggested": 150,
                "reason": "Reduce exposure to respect drawdown constraint",
            })
        
        if performance.get('win_rate', 0) < 0.4:
            recommendations.append("Win rate is low. Consider adjusting entry timing or phase thresholds.")
        
        if performance.get('return_trend', 0) < 0:
            recommendations.append("Negative return trend detected. Review P1/P2 phase timing.")
        
        return StrategyReview(
            timestamp=datetime.now().isoformat(),
            episode=episode,
            total_episodes=total_episodes,
            training_stats=performance,
            performance_metrics=performance,
            recommendations=recommendations,
            strategy_changes=strategy_changes,
            token_budget_used=0,
            review_type="fallback",
        )
    
    def _save_review(self, review: StrategyReview):
        filename = f"review_ep{review.episode:06d}.json"
        filepath = self.output_dir / filename
        
        with open(filepath, 'w') as f:
            json.dump(asdict(review), f, indent=2)
    
    def _print_review_summary(self, review: StrategyReview):
        print("\n" + "=" * 60)
        print(f"Strategy Review at Episode {review.episode}")
        print("=" * 60)
        
        print(f"\nConstraint Status: {review.performance_metrics.get('constraint_status', 'N/A')}")
        print(f"Review Type: {review.review_type.upper()}")
        print(f"Tokens Used: {review.token_budget_used}")
        
        if review.recommendations:
            print("\nRecommendations:")
            for i, rec in enumerate(review.recommendations, 1):
                print(f"  {i}. {rec}")
        
        if review.strategy_changes:
            print("\nSuggested Strategy Changes:")
            for change in review.strategy_changes:
                print(f"  - {change.get('parameter')}: {change.get('current')} -> {change.get('suggested')}")
                print(f"    Reason: {change.get('reason', 'N/A')}")
        
        print()
    
    def save_summary(self, filepath: str = None):
        if filepath is None:
            filepath = self.output_dir / "review_summary.json"
        
        summary = {
            'total_reviews': len(self.review_history),
            'total_tokens_used': self.total_tokens_used,
            'reviews': [asdict(r) for r in self.review_history],
        }
        
        with open(filepath, 'w') as f:
            json.dump(summary, f, indent=2)
        
        print(f"Review summary saved to {filepath}")
    
    def get_latest_recommendations(self) -> List[Dict]:
        if not self.review_history:
            return []
        
        latest = self.review_history[-1]
        return latest.strategy_changes


def create_reviewer(api_key: str = None) -> StrategyReviewer:
    config = LLMReviewerConfig(api_key=api_key)
    return StrategyReviewer(config=config)


if __name__ == "__main__":
    reviewer = create_reviewer()
    
    sample_stats = [
        {'episode': i, 'episode_return': 5.0 + i*0.1 + (i % 3 - 1) * 2, 'max_drawdown': -10 - i*0.05}
        for i in range(100)
    ]
    
    performance = reviewer.analyze_performance(sample_stats, 100)
    print("Performance Analysis:")
    for k, v in performance.items():
        print(f"  {k}: {v}")
    
    print("\nReview Prompt Preview:")
    print(reviewer.generate_review_prompt(100, 10000, performance))
