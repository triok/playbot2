import { useEffect, useState } from 'react';

interface MarketInfoProps {
  conditionId: string;
  slug: string;
  any;
  onClose: () => void;
}

// Цвета для категорий
const CATEGORY_COLORS = {
  'error': 'bg-red-500/20 text-red-400 border-red-500/30',
  'order_canceled': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'autobidbot_buy': 'bg-green-500/20 text-green-400 border-green-500/30',
  'autobidbot_sell': 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  'autobidbot_stage': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'user_polymarket_websocket_trade': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  'user_polymarket_websocket_order': 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
  'user_polymarket_websocket_sell': 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  'polymarket_handler': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'default': 'bg-slate-700 text-slate-300 border-slate-600'
};

export default function MarketInfo({ conditionId, slug, data, onClose }: MarketInfoProps) {
  const [copied, setCopied] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [showMarketData, setShowMarketData] = useState(false);
  const [showOppData, setShowOppData] = useState(false);

  // Загрузка логов при монтировании компонента
  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const response = await fetch(`/api/market-logs/${conditionId}`);
        const result = await response.json();
        
        if (result.success) {
          setLogs(result.logs || []);
          setLogsError(null);
        } else {
          setLogsError(result.message || 'Failed to load logs');
        }
      } catch (error) {
        setLogsError('Network error while loading logs');
        console.error('Error fetching logs:', error);
      } finally {
        setLogsLoading(false);
      }
    };
    
    fetchLogs();
  }, [conditionId]);

  const copyJSON = () => {
    navigator.clipboard?.writeText(JSON.stringify(data, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
  };

  // Закрытие по нажатию на клавишу Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Закрытие по клику/касанию на оверлей
  const handleOverlayClick = (e: React.MouseEvent | React.TouchEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Форматирование данных лога для отображения
  const formatLogData = (logData: any) => {
    if (!logData) return '—';
    
    // Если это объект с сообщением
    if (typeof logData === 'object' && logData.message) {
      const { message, ...rest } = logData;
      const restString = Object.keys(rest).length > 0 
        ? '\n\n' + JSON.stringify(rest, null, 2) 
        : '';
      return message + restString;
    }
    
    // Если это объект - форматируем как JSON
    if (typeof logData === 'object') {
      return JSON.stringify(logData, null, 2);
    }
    
    // Для всего остального - просто строка
    return String(logData);
  };

  // Получение цвета для категории
  const getCategoryStyle = (category: string) => {
    return CATEGORY_COLORS[category as keyof typeof CATEGORY_COLORS] || CATEGORY_COLORS.default;
  };

  // Копирование информации о позициях
  const formatPositionsForGPT = () => {
    if (!data.positionsHistory || data.positionsHistory.length === 0) {
      return 'No positions history';
    }
  
    let output = `Market: ${slug}\nCondition ID: ${conditionId}\n\n`;
  
    data.positionsHistory.forEach((snap: any, index: number) => {
      const totalInvested = snap.positions.reduce(
        (sum: number, p: any) => sum + Number(p.initialValue), 0
      );
  
      output += `=== SNAPSHOT #${index + 1} ===\n`;
      output += `Time: ${snap.time}\n`;
      output += `Total Invested: ${totalInvested.toFixed(4)}\n\n`;
  
      snap.positions.forEach((p: any, i: number) => {
        const avgPrice = p.size > 0
          ? Number(p.initialValue) / Number(p.size)
          : 0;
  
        output += `Position ${i === 0 ? 'A' : 'B'}:\n`;
        output += `- Outcome: ${p.outcome}\n`;
        output += `- Current Price: ${p.currentPrice ?? '—'}\n`;
        output += `- Size: ${Number(p.size).toFixed(2)}\n`;
        output += `- Initial Value: ${Number(p.initialValue).toFixed(4)}\n`;
        output += `- Avg Price: ${avgPrice.toFixed(4)}\n\n`;
      });
  
      output += `-----------------------------\n\n`;
    });
  
    return output;
  };

  const copyPositions = () => {
    const text = formatPositionsForGPT();
  
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
  
      // важно для мобильных и overlay
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.opacity = '0';
  
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
  
      const success = document.execCommand('copy');
  
      document.body.removeChild(textarea);
  
      if (success) {
        alert('Copied ✅');
      } else {
        alert('Copy failed ❌');
      }
    } catch (err) {
      console.error(err);
      alert('Copy error ❌');
    }
  }; 
  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-90 z-50 flex items-center justify-center p-4 overflow-auto"
      onClick={handleOverlayClick}
      onTouchStart={handleOverlayClick}
    >
      <div className="bg-slate-900 rounded-lg w-full max-w-6xl max-h-[90vh] overflow-auto relative">
        {/* Close Button */}
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-white text-3xl z-10 bg-slate-800 hover:bg-slate-700 rounded-full w-12 h-12 flex items-center justify-center transition shadow-lg shadow-black/50"
          title="Закрыть (Нажмите ×, Esc или кликните снаружи)"
        >
          &times;
        </button>

        {/* Header */}
        <div className="sticky top-0 bg-slate-900 border-b border-slate-700 pb-4 pt-4 px-6 z-10">
          <h1 className="text-3xl font-bold text-indigo-400 mb-2">
            📊 {slug}
          </h1>
          <p className="text-slate-400 text-sm">
            Condition ID: <code className="bg-slate-800 px-2 py-1 rounded">{conditionId}</code>
          </p>
          <p className="text-slate-500 text-xs mt-1">
            Загружено: {new Date(data.timestamp || Date.now()).toLocaleString('ru-RU')}
          </p>
          <p className="text-slate-500 text-xs">
            Технических логов: {logsLoading ? '...' : logs.length}
          </p>
        </div>

        {/* Content */}
        <div className="p-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Market Data */}
            <div className="bg-slate-800 rounded-lg p-6">
              <button
                onClick={() => setShowMarketData(v => !v)}
                className="w-full flex justify-between items-center text-left"
              >
                <h2 className="text-xl font-bold text-indigo-300">📈 Market Data</h2>
                <span className="text-slate-400 text-sm">{showMarketData ? '▲ Свернуть' : '▼ Развернуть'}</span>
              </button>

              {showMarketData && (
                <div className="space-y-3 text-sm max-h-[60vh] overflow-y-auto mt-4">
                  {Object.entries(data.market || {}).map(([key, value]) => (
                    <div key={key} className="flex justify-between border-b border-slate-700 pb-2">
                      <span className="text-slate-400">
                        {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}:
                      </span>
                      <span className="text-slate-200 font-mono break-all max-w-[300px] text-right">
                        {typeof value === 'boolean' ? (value ? 'true' : 'false') :
                        typeof value === 'object' ? JSON.stringify(value, null, 2) :
                        String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Opportunity Data */}
            <div className="bg-slate-800 rounded-lg p-6">
              <button
                onClick={() => setShowOppData(v => !v)}
                className="w-full flex justify-between items-center text-left"
              >
                <h2 className="text-xl font-bold text-indigo-300">🎯 Opportunity Data</h2>
                <span className="text-slate-400 text-sm">{showOppData ? '▲ Свернуть' : '▼ Развернуть'}</span>
              </button>

              {showOppData && (
                <div className="space-y-3 text-sm max-h-[60vh] overflow-y-auto mt-4">
                  {Object.entries(data.opp || {}).map(([key, value]) => (
                    <div key={key} className="flex justify-between border-b border-slate-700 pb-2">
                      <span className="text-slate-400">
                        {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}:
                      </span>
                      <span className="text-slate-200 font-mono break-all max-w-[300px] text-right">
                        {typeof value === 'boolean' ? (value ? 'true' : 'false') :
                        typeof value === 'object' ? JSON.stringify(value, null, 2) :
                        String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Additional Text */}
            {data.text && (
              <div className="bg-slate-800 rounded-lg p-6 lg:col-span-2">
                <h2 className="text-xl font-bold text-indigo-300 mb-4">📝 Additional Info</h2>
                <pre className="bg-slate-900 p-4 rounded overflow-auto text-sm text-slate-300">
                  {data.text}
                </pre>
              </div>
            )}
          </div>

          {/* Positions history */}
          {data.positionsHistory && data.positionsHistory.length > 0 && (
            <div className="mt-8 bg-slate-800 rounded-lg p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-indigo-300">📊 Positions History</h2>

                <div className="flex items-center gap-3">
                  <button
                    onClick={copyPositions}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1 rounded"
                  >
                    📋 Copy for GPT
                  </button>

                  {(() => {
                    const lastSnap = data.positionsHistory[data.positionsHistory.length - 1];
                    const totalInvested = lastSnap?.positions?.reduce(
                      (sum: number, p: any) => sum + Number(p.initialValue), 0
                    ) ?? 0;
                    return (
                      <span className="text-sm text-slate-400 font-mono">
                        Total invested:{' '}
                        <span className="text-green-400 font-bold">
                          ${totalInvested.toFixed(4)}
                        </span>
                      </span>
                    );
                  })()}
                </div>                

              </div>

              <div className="space-y-4">
                {data.positionsHistory.map((snap: any, index: number) => {
                  const totalInvested = snap.positions.reduce(
                    (sum: number, p: any) => sum + Number(p.initialValue), 0
                  );

                  return (
                    <div key={index} className="bg-slate-900 rounded-lg p-4 border border-slate-700">
                      {/* Заголовок снапшота */}
                      <div className="flex justify-between items-center mb-3">
                        <span className="text-slate-400 text-sm font-mono">
                          #{index + 1}
                        </span>
                        <span className="text-slate-300 text-sm font-mono font-semibold">
                          🕐 {snap.time}
                        </span>
                        <span className="text-slate-500 text-xs font-mono">
                          Total: <span className="text-yellow-400">${totalInvested.toFixed(4)}</span>
                        </span>
                      </div>

                      {/* Таблица позиций */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs font-mono">
                          <thead>
                            <tr className="border-b border-slate-700">
                              <th className="text-left text-slate-500 pb-2 pr-3">#</th>
                              <th className="text-left text-slate-500 pb-2 pr-3">Outcome</th>
                              <th className="text-right text-slate-500 pb-2 pr-3">Cur.Price</th>
                              <th className="text-right text-slate-500 pb-2 pr-3">Size</th>
                              <th className="text-right text-slate-500 pb-2 pr-3">Initial $</th>
                              <th className="text-right text-slate-500 pb-2 pr-3">Avg</th>
                              <th className="text-right text-slate-500 pb-2 pr-3">Profit $</th>
                              <th className="text-right text-slate-500 pb-2">Profit %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snap.positions.map((p: any, i: number) => {
                              const avgPrice = p.size > 0
                                ? Number(p.initialValue) / Number(p.size)
                                : 0;
                              const label = i === 0 ? 'A' : 'B';

                              // Profit если этот исход победит: Size - I_total
                              const profit = Number(p.size) - totalInvested;
                              const profitPerc = totalInvested > 0
                                ? (profit / totalInvested * 100)
                                : 0;

                              const avgColor = avgPrice < 0.45
                                ? 'text-green-400'
                                : avgPrice > 0.60
                                ? 'text-red-400'
                                : 'text-yellow-400';

                              const profitColor = profit > 0
                                ? 'text-green-400'
                                : profit < 0
                                ? 'text-red-400'
                                : 'text-slate-400';

                              return (
                                <tr key={i} className="border-b border-slate-800">
                                  <td className="py-2 pr-3 text-slate-500">{label}</td>
                                  <td className="py-2 pr-3 text-slate-200 font-semibold">
                                    {p.outcome}
                                  </td>
                                  <td className="py-2 pr-3 text-right text-slate-400">
                                    {p.currentPrice != null ? p.currentPrice.toFixed(3) : '—'}
                                  </td>                                  
                                  <td className="py-2 pr-3 text-right text-slate-300">
                                    {Number(p.size).toFixed(2)}
                                  </td>
                                  <td className="py-2 pr-3 text-right text-slate-300">
                                    ${Number(p.initialValue).toFixed(4)}
                                  </td>
                                  <td className={`py-2 pr-3 text-right font-bold ${avgColor}`}>
                                    {avgPrice.toFixed(3)}
                                  </td>
                                  <td className={`py-2 pr-3 text-right font-bold ${profitColor}`}>
                                    {profit >= 0 ? '+' : ''}{profit.toFixed(3)}
                                  </td>
                                  <td className={`py-2 text-right font-bold ${profitColor}`}>
                                    {profitPerc >= 0 ? '+' : ''}{profitPerc.toFixed(1)}%
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="border-t border-slate-600">
                              <td colSpan={5} className="pt-2 text-slate-500 text-xs">
                                pairCost:{' '}
                                {snap.positions.length >= 2 ? (() => {
                                  const avg0 = snap.positions[0].size > 0
                                    ? snap.positions[0].initialValue / snap.positions[0].size : 0;
                                  const avg1 = snap.positions[1].size > 0
                                    ? snap.positions[1].initialValue / snap.positions[1].size : 0;
                                  const pc = avg0 + avg1;
                                  return (
                                    <span className={pc < 1.0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                                      {pc.toFixed(3)} {pc < 1.0 ? '✅' : '⚠️'}
                                    </span>
                                  );
                                })() : '—'}
                              </td>
                              <td className="pt-2 text-right text-yellow-400 font-bold" colSpan={3}>
                                I_total: ${totalInvested.toFixed(4)}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}          

          {/* Action Logs */}
          {data.actionLogs && data.actionLogs.length > 0 && (
            <div className="mt-8 bg-slate-800 rounded-lg p-6">
              <h2 className="text-xl font-bold text-indigo-300 mb-4">
                🤖 Action Logs
                <span className="ml-3 text-sm font-normal text-slate-400">
                  {data.actionLogs.length} записей
                </span>
              </h2>

              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-slate-800">
                    <tr className="border-b border-slate-600">
                      <th className="text-left text-slate-400 pb-2 pr-4 py-2">Time</th>
                      <th className="text-right text-slate-400 pb-2 pr-4 py-2">P_A</th>
                      <th className="text-right text-slate-400 pb-2 pr-4 py-2">P_B</th>
                      <th className="text-right text-slate-400 pb-2 pr-4 py-2">Profit A</th>
                      <th className="text-right text-slate-400 pb-2 pr-4 py-2">Profit B</th>
                      <th className="text-right text-slate-400 pb-2 pr-4 py-2">Budget Left</th>
                      <th className="text-left text-slate-400 pb-2 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.actionLogs.map((entry: any, i: number) => {
                      const profitAColor = entry.Profit_A > 0
                        ? 'text-green-400' : entry.Profit_A < 0
                        ? 'text-red-400' : 'text-slate-400';
                      const profitBColor = entry.Profit_B > 0
                        ? 'text-green-400' : entry.Profit_B < 0
                        ? 'text-red-400' : 'text-slate-400';
                      const isWaiting   = entry.action?.startsWith('waiting');
                      const isBuy       = entry.action?.includes('buy') || entry.action?.includes('P1') || entry.action?.includes('P2') || entry.action?.includes('P3') || entry.action?.includes('P4');
                      const isRisk      = entry.action?.includes('Risk') || entry.action?.includes('LAST') || entry.action?.includes('frozen');

                      const actionColor = isRisk    ? 'text-red-400'
                                        : isBuy     ? 'text-green-400'
                                        : isWaiting ? 'text-slate-500'
                                        : 'text-yellow-400';

                      return (
                        <tr key={i} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                          <td className="py-1.5 pr-4 text-slate-400">{entry.time}</td>
                          <td className="py-1.5 pr-4 text-right text-slate-300">{entry.P_A?.toFixed(2)}</td>
                          <td className="py-1.5 pr-4 text-right text-slate-300">{entry.P_B?.toFixed(2)}</td>
                          <td className={`py-1.5 pr-4 text-right font-bold ${profitAColor}`}>
                            {entry.Profit_A >= 0 ? '+' : ''}{entry.Profit_A?.toFixed(2)}
                          </td>
                          <td className={`py-1.5 pr-4 text-right font-bold ${profitBColor}`}>
                            {entry.Profit_B >= 0 ? '+' : ''}{entry.Profit_B?.toFixed(2)}
                          </td>
                          <td className="py-1.5 pr-4 text-right text-slate-400">
                            ${entry.budgetLeft?.toFixed(2)}
                          </td>
                          <td className={`py-1.5 ${actionColor} max-w-[300px] truncate`} title={entry.action}>
                            {entry.action}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Technical Logs */}
          <div className="mt-8 bg-slate-800 rounded-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-indigo-300">🔧 Technical Logs</h2>
              <span className={`text-xs px-3 py-1 rounded ${
                logsLoading ? 'bg-yellow-500/20 text-yellow-400' :
                logsError ? 'bg-red-500/20 text-red-400' :
                'bg-green-500/20 text-green-400'
              }`}>
                {logsLoading ? 'Loading...' : 
                 logsError ? `Error: ${logsError}` : 
                 `${logs.length} entries`}
              </span>
            </div>
            
            {logsLoading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500 mx-auto"></div>
                <p className="mt-4 text-slate-400">Загрузка технических логов...</p>
              </div>
            ) : logsError ? (
              <div className="text-center py-8 text-red-400">
                <p>{logsError}</p>
              </div>
            ) : logs.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                <p>Нет технических логов для этого рынка</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-[600px] overflow-y-auto">
                {logs.map((log, index) => {
                  const categoryStyle = getCategoryStyle(log.category);
                  const formattedData = formatLogData(log.data);
                  
                  return (
                    <div 
                      key={index} 
                      className={`bg-slate-900 p-4 rounded-lg border ${categoryStyle} text-sm`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-xs font-mono text-slate-400">
                          {log.local_time || log.moscowTime || log.timestamp}
                        </span>
                        <span className={`text-xs px-2 py-1 rounded font-semibold`}>
                          {log.category}
                        </span>
                      </div>
                      
                      <div className="text-slate-300 font-mono text-xs whitespace-pre-wrap break-words">
                        {formattedData}
                      </div>
                      
                      {/* Дополнительная информация для торговых событий */}
                      {log.category === 'user_polymarket_websocket_trade' && log.data?.status && (
                        <div className="mt-2 pt-2 border-t border-slate-700">
                          <div className="text-xs text-slate-400">
                            <div><span className="text-slate-500">Status:</span> {log.data.status}</div>
                            <div><span className="text-slate-500">Side:</span> {log.data.side}</div>
                            <div><span className="text-slate-500">Price:</span> {log.data.price}</div>
                            <div><span className="text-slate-500">Size:</span> {log.data.size}</div>
                            <div><span className="text-slate-500">Outcome:</span> {log.data.outcome}</div>
                          </div>
                        </div>
                      )}
                      
                      {/* Дополнительная информация для ордеров */}
                      {log.category === 'user_polymarket_websocket_order' && log.data?.status && (
                        <div className="mt-2 pt-2 border-t border-slate-700">
                          <div className="text-xs text-slate-400">
                            <div><span className="text-slate-500">Status:</span> {log.data.status}</div>
                            <div><span className="text-slate-500">Side:</span> {log.data.side}</div>
                            <div><span className="text-slate-500">Price:</span> {log.data.price}</div>
                            <div><span className="text-slate-500">Size:</span> {log.data.original_size}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}