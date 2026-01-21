import React, { useEffect, useRef, useState } from 'react';
import { LogEntry } from '../types';

interface ConsoleProps {
  logs: LogEntry[];
}

const Console: React.FC<ConsoleProps> = ({ logs }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, collapsed]);

  return (
    <div
      className={`
        flex flex-col bg-slate-950 border border-slate-800 rounded-lg
        font-mono text-sm shadow-xl transition-all duration-300
        ${collapsed ? 'h-auto' : 'h-[400px]'}
      `}
    >
      {/* HEADER */}
      <div
        onClick={() => setCollapsed(prev => !prev)}
        className="bg-slate-900 px-4 py-2 border-b border-slate-800
                   flex items-center justify-between cursor-pointer
                   select-none hover:bg-slate-800 transition-colors"
      >
        <span className="text-slate-400 font-semibold flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          SYSTEM LOGS
        </span>

        <span className="flex items-center gap-3 text-xs text-slate-600">
          v2.0.4-stable
          <span
            className={`transition-transform duration-300 ${
              collapsed ? 'rotate-180' : ''
            }`}
          >
            ▼
          </span>
        </span>
      </div>

      {/* BODY — рендерится ТОЛЬКО если не свернуто */}
      {!collapsed && (
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 space-y-2 text-slate-300"
        >
          {logs.length === 0 && (
            <div className="text-slate-600 italic">
              Waiting for process initialization...
            </div>
          )}

          {logs.map((log) => (
            <div key={log.id} className="flex gap-3 break-words">
              <span className="text-slate-500 shrink-0">
                [{log.timestamp}]
              </span>
              <span
                className={`
                  ${log.type === 'error' ? 'text-red-400' : ''}
                  ${log.type === 'success' ? 'text-emerald-400' : ''}
                  ${log.type === 'warning' ? 'text-amber-400' : ''}
                  ${log.type === 'info' ? 'text-blue-300' : ''}
                `}
              >
                {log.type === 'success' && '✓ '}
                {log.type === 'error' && '✕ '}
                {log.type === 'warning' && '⚠ '}
                {log.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Console;
