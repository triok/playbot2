import React from 'react';

interface StatsCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  trend?: string;
  trendColor?: string;
}

const StatsCard: React.FC<StatsCardProps> = ({ label, value, icon, trend, trendColor }) => {
  return (
    <div className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg flex items-center justify-between">
      <div>
        <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-1">{label}</p>
        <h3 className="text-2xl font-bold text-white">{value}</h3>
        {trend && (
          <p className={`text-xs mt-1 ${trendColor || 'text-slate-400'}`}>
            {trend}
          </p>
        )}
      </div>
      <div className="p-3 bg-slate-700/50 rounded-lg text-slate-300">
        {icon}
      </div>
    </div>
  );
};

export default StatsCard;