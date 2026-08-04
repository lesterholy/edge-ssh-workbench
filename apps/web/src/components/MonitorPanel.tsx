import { Activity, Cpu, HardDrive, MemoryStick, Shield } from "lucide-react";
import type { ServerMetricsMessageSchema } from "@edgesh/contracts";
import type { MessageKey } from "../lib/i18n";

type Metrics = typeof ServerMetricsMessageSchema._output;
type Props = { metrics?: Metrics; t: (key: MessageKey) => string };

function usage(value: Metrics["memory"], unsupported: string) {
  if (value.support !== "supported" || !value.value) return { percent: 0, text: unsupported };
  return {
    percent: value.value.percent,
    text: `${(value.value.usedBytes / 1073741824).toFixed(1)} / ${(value.value.totalBytes / 1073741824).toFixed(1)} GB`
  };
}

export function MonitorPanel({ metrics, t }: Props) {
  const cpu = metrics?.cpu.support === "supported" ? metrics.cpu.value ?? 0 : 0;
  const memory = metrics ? usage(metrics.memory, t("unsupported")) : { percent: 0, text: "--" };
  const swap = metrics ? usage(metrics.swap, t("unsupported")) : { percent: 0, text: "--" };
  const disk = metrics ? usage(metrics.rootDisk, t("unsupported")) : { percent: 0, text: "--" };
  const processes = metrics?.processes.support === "supported" ? metrics.processes.value ?? [] : [];
  const firewall = metrics?.firewall;

  return (
    <aside className="monitor-panel">
      <div className="section-heading"><span><Activity size={17} /> {t("liveStatus")}</span></div>
      <Metric icon={<Cpu size={15} />} label="CPU" percent={cpu} text={metrics ? `${Math.round(cpu)}%` : "--"} />
      <Metric icon={<MemoryStick size={15} />} label="Memory" percent={memory.percent} text={memory.text} />
      <Metric icon={<MemoryStick size={15} />} label="Swap" percent={swap.percent} text={swap.text} />
      <Metric icon={<HardDrive size={15} />} label="Disk" percent={disk.percent} text={disk.text} />
      <div className="firewall-heading"><span><Shield size={15} /> {t("firewall")}</span></div>
      {firewall?.support === "supported" && firewall.value ? (
        <div>
          <div className="firewall-status">
            <span className={`badge ${firewall.value.status}`}>{t(firewall.value.status === "active" ? "ufwActive" : "ufwInactive")}</span>
            {firewall.value.defaultIncoming ? <span>{t("firewallDefault")}: {firewall.value.defaultIncoming} / {firewall.value.defaultOutgoing}</span> : null}
          </div>
          {firewall.value.logging ? <div className="firewall-meta">{t("firewallLogging")}: {firewall.value.logging}</div> : null}
          {firewall.value.status === "active" && firewall.value.rules.length > 0 ? (
            <div className="firewall-table">
              <div className="firewall-row firewall-header"><span>{t("firewallTo")}</span><span>{t("firewallAction")}</span><span>{t("firewallFrom")}</span></div>
              {firewall.value.rules.map((rule, index) => (
                <div className="firewall-row" key={index}>
                  <span title={rule.destination}>{rule.destination}</span>
                  <span>{rule.action}</span>
                  <span title={rule.source}>{rule.source}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="firewall-status">
          <span className={`badge ${metrics ? "unsupported" : "pending"}`}>{metrics ? t("unsupported") : "--"}</span>
        </div>
      )}

      <div className="process-heading">{t("processes")}</div>
      <div className="process-table">
        <div className="process-row process-header"><span>PID</span><span>CPU</span><span>COMMAND</span></div>
        {processes.map((process) => (
          <div className="process-row" key={process.pid}>
            <span>{process.pid}</span><span>{process.cpuPercent.toFixed(1)}%</span><span title={process.command}>{process.command}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Metric({ icon, label, percent, text }: { icon: React.ReactNode; label: string; percent: number; text: string }) {
  return (
    <div className="metric-row">
      <div className="metric-label"><span>{icon}{label}</span><strong>{text}</strong></div>
      <div className="meter"><span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div>
    </div>
  );
}
