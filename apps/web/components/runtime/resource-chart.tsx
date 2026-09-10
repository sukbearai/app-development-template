"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type AdminResourceChartProps = {
  data: Array<{
    label: string;
    value: number;
  }>;
};

export function AdminResourceChart({ data }: AdminResourceChartProps) {
  return (
    <div className="admin-chart" aria-label="管理端资源分布图">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="#dde3ed" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <Tooltip cursor={{ fill: "rgb(15 118 110 / 8%)" }} />
          <Bar dataKey="value" fill="#0f766e" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
