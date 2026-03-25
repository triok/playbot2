@echo off
chcp 65001
for /L %%i in (1, 1, 15) do (
   echo Запуск части %%i из 15...
   node --max-old-space-size=4096 --expose-gc run_backtest.js %%i
   echo Часть %%i завершена.
)
echo Все части успешно обработаны!
pause