import React, { useState } from 'react';

export const BacktestView = () => {
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const loadReport = async () => {
    setLoading(true);
    try {
      // v=Date.now() нужен, чтобы браузер не брал старый файл из кэша
      const res = await fetch('/backtest_result.json?v=' + Date.now());
      const data = await res.json();
      setReport(data);
    } catch (e) {
      alert("Файл отчета не найден. Сначала запустите node run_backtest.js");
    }
    setLoading(false);
  };

  if (!report) {
    return (
      <div style={{ padding: '20px' }}>
        <button onClick={loadReport} style={btnStyle}>
          {loading ? 'Загрузка...' : 'Показать результаты последнего бэктеста'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', backgroundColor: '#0f172a', color: '#f8fafc', fontFamily: 'monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ fontSize: '24px', margin: 0 }}>📊 Лаборатория Бэктеста</h1>
        <button onClick={loadReport} style={btnStyle}>Обновить данные</button>
      </div>
      
      {/* СВОДНАЯ ТАБЛИЦА */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '30px' }}>
        <StatCard title="Общий PnL" value={`$${(report.summary?.totalPnL || 0).toFixed(2)}`} color={(report.summary?.totalPnL || 0) >= 0 ? '#4ade80' : '#f87171'} />
        <StatCard title="Инвестировано" value={`$${(report.summary?.totalInvested || 0).toFixed(2)}`} color="#60a5fa" />
        <StatCard title="Побед" value={report.summary?.wins || 0} color="#4ade80" />
        <StatCard title="Поражений" value={report.summary?.losses || 0} color="#f87171" />
      </div>

      {/* СПИСОК МАРКЕТОВ */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {report.markets?.map((market: any, index: number) => (
          // Используем marketId как уникальный ключ
          <MarketItem key={market.marketId || index} market={market} index={index + 1} />
        ))}
      </div>
    </div>
  );
};

const MarketItem = ({ market, index }: any) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const pnl = market.pnl || 0;
  const invested = market.totalInvested || 0;
  const isWin = pnl >= 0;

  return (
    <div style={{ border: '1px solid #334155', borderRadius: '8px', overflow: 'hidden' }}>
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        style={{ 
          padding: '12px 15px', 
          cursor: 'pointer', 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          backgroundColor: isWin ? '#064e3b' : '#450a0a' 
        }}
      >
        <div style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          <span style={{ opacity: 0.5 }}>#{index}</span>
          <span style={{ fontWeight: 'bold', fontSize: '14px' }}>{market.title} | ${invested.toFixed(1)}</span>
        </div>
        <div style={{ fontWeight: 'bold' }}>
          {isWin ? '+' : ''}{pnl.toFixed(2)}$ 
          <span style={{ marginLeft: '10px', fontSize: '12px', opacity: 0.8 }}>
            ({invested > 0 ? ((pnl / invested) * 100).toFixed(1) : 0}%)
          </span>
        </div>
      </div>

      {isExpanded && (
        <div style={{ padding: '15px', backgroundColor: '#1e293b' }}>
          <div style={{ marginBottom: '15px', fontSize: '13px', color: '#94a3b8' }}>
            Market ID: <span style={{ color: '#ccc' }}>{market.clobId} | {market.marketId}</span> | 
            Победитель: <span style={{ color: '#4ade80' }}>{market.winner}</span> | 
            Вложено: <span style={{ color: '#fff' }}>${invested.toFixed(2)}</span>
          </div>
          
          <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #334155', borderRadius: '4px' }}>
            <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, backgroundColor: '#0f172a', zIndex: 1 }}>
                <tr>
                  <th style={thStyle}>Время</th>
                  <th style={thStyle}>Цена A</th>
                  <th style={thStyle}>Цена B</th>
                  <th style={thStyle}>Действие</th>
                </tr>
              </thead>
              <tbody>
                {market.history?.map((h: any, i: number) => (
                    <React.Fragment key={i}>
                    <tr style={{ borderBottom: '1px solid #334155', backgroundColor: h.act?.includes('ИСПОЛНЕНО') ? '#064e3b44' : 'transparent' }}>
                        <td style={tdStyle}>{h.t}</td>
                        <td style={tdStyle}>{h.pA}</td>
                        <td style={tdStyle}>{h.pB}</td>
                        <td style={{ ...tdStyle, color: '#fde047', fontWeight: 'bold' }}>
                        {h.act || '---'}
                        </td>
                    </tr>
                    {/* Если в этом тике есть снимок позиций — выводим доп. строку с инфой */}
                    {h.snapshot && h.snapshot.length > 0 && (
                    <tr style={{ backgroundColor: '#0f172a' }}>
                        <td colSpan={4} style={{ padding: '8px 15px', fontSize: '11px', color: '#94a3b8' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                            <tr style={{ color: '#475569' }}>
                                <th style={{ textAlign: 'left', padding: '3px 8px' }}>Исход</th>
                                <th style={{ textAlign: 'right', padding: '3px 8px' }}>Шт</th>
                                <th style={{ textAlign: 'right', padding: '3px 8px' }}>Вложено</th>
                                <th style={{ textAlign: 'right', padding: '3px 8px' }}>PnL $</th>
                                <th style={{ textAlign: 'right', padding: '3px 8px' }}>PnL %</th>
                            </tr>
                            </thead>
                            <tbody>
                            {h.snapshot.map((p: any, pi: number) => (
                                <tr key={pi} style={{ borderTop: '1px solid #1e293b' }}>
                                <td style={{ padding: '3px 8px' }}>📦 {p.outcome}</td>
                                <td style={{ textAlign: 'right', padding: '3px 8px' }}><b>{p.size.toFixed(2)}</b></td>
                                <td style={{ textAlign: 'right', padding: '3px 8px' }}>${p.initialValue.toFixed(2)}</td>
                                <td style={{ textAlign: 'right', padding: '3px 8px', color: p.pnlIfWin >= 0 ? '#22c55e' : '#ef4444' }}>
                                    {p.pnlIfWin >= 0 ? '+' : ''}{p.pnlIfWin?.toFixed(2) ?? '—'}
                                </td>
                                <td style={{ textAlign: 'right', padding: '3px 8px', color: p.pnlIfWinPct >= 0 ? '#22c55e' : '#ef4444' }}>
                                    {p.pnlIfWinPct >= 0 ? '+' : ''}{p.pnlIfWinPct?.toFixed(1) ?? '—'}%
                                </td>
                                </tr>
                            ))}
                            </tbody>
                        </table>
                        </td>
                    </tr>
                    )}
                    </React.Fragment>
                ))}
                </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

const StatCard = ({ title, value, color }: any) => (
  <div style={{ padding: '15px', backgroundColor: '#1e293b', borderRadius: '8px', border: '1px solid #334155' }}>
    <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '1px' }}>{title}</div>
    <div style={{ fontSize: '22px', fontWeight: 'bold', color: color }}>{value}</div>
  </div>
);

const btnStyle = { 
  padding: '8px 16px', 
  backgroundColor: '#3b82f6', 
  color: 'white', 
  border: 'none', 
  borderRadius: '4px', 
  cursor: 'pointer', 
  fontWeight: 'bold',
  fontSize: '13px'
};

const thStyle: React.CSSProperties = { padding: '10px', textAlign: 'left', borderBottom: '1px solid #475569', color: '#94a3b8' };
const tdStyle: React.CSSProperties = { padding: '8px 10px', textAlign: 'left' };
export default BacktestView;