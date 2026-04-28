@echo off
echo 🚀 Запускаем бэктест...
node run_backtest.js

echo.
echo 📊 Анализируем худшие маркеты...
node run_market_chart.js LOSERS

echo.
echo 🏆 Анализируем лучшие маркеты...
node run_market_chart.js WINNERS

echo.
echo ✅ Готово!
pause