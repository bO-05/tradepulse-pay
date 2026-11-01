import { getErrorMessage } from "../lib/errors.ts";
import React, { useState } from "react";
import { formatFullDateTime } from "../lib/datetime.ts";
import {
  Clock,
  ShieldCheck,
  Send,
  MessageSquareCode,
  Scale,
  Award,
  FileText,
  RefreshCw,
  Play,
  CheckCircle2,
  Calendar,
  Layers,
  AlertTriangle,
} from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import { Project, AuditLog } from "../types.ts";

interface ActivityAuditStreamViewProps {
  currentProject: Project | null;
  fallbackLogs?: AuditLog[];
  onRunDeadlineCron?: () => Promise<void>;
  onRunComplianceCron?: () => Promise<void>;
}

export const ActivityAuditStreamView: React.FC<ActivityAuditStreamViewProps> = ({
  currentProject,
  fallbackLogs = [],
  onRunDeadlineCron,
  onRunComplianceCron,
}) => {
  const [runningDeadline, setRunningDeadline] = useState(false);
  const [runningCompliance, setRunningCompliance] = useState(false);
  const [cronError, setCronError] = useState<string | null>(null);

  // Live WebSocket query for real-time audit logs (Zero Polling Invariant), with resilient fallback
  const logsData = useQuery(
    api.auditLogs.listRecentLogs,
    currentProject && !currentProject._id.startsWith("proj_") ? { projectId: currentProject._id as any, limit: 100 } : {}
  );
  const logs: AuditLog[] = (logsData as any) ?? fallbackLogs;

  const cronStatusData = useQuery(api.crons.getCronStatus);

  const runDeadlineMutation = useMutation(api.crons.runDeadlineMonitorNow);
  const runComplianceMutation = useMutation(api.crons.runComplianceAuditNow);

  const handleRunDeadlineCron = async () => {
    setRunningDeadline(true);
    setCronError(null);
    try {
      if (onRunDeadlineCron) {
        await onRunDeadlineCron();
      } else {
        if (!currentProject || currentProject._id.startsWith("proj_")) {
          throw new Error("Select a connected project before running the deadline monitor.");
        }
        await runDeadlineMutation({ projectId: currentProject._id as any });
      }
    } catch (err: any) {
      console.warn("Deadline cron fallback:", err);
      setCronError(getErrorMessage(err) || "The deadline monitor could not be executed.");
    } finally {
      setRunningDeadline(false);
    }
  };

  const handleRunComplianceCron = async () => {
    setRunningCompliance(true);
    setCronError(null);
    try {
      if (onRunComplianceCron) {
        await onRunComplianceCron();
      } else {
        if (!currentProject || currentProject._id.startsWith("proj_")) {
          throw new Error("Select a connected project before running the compliance audit.");
        }
        await runComplianceMutation({ projectId: currentProject._id as any });
      }
    } catch (err: any) {
      console.warn("Compliance cron fallback:", err);
      setCronError(getErrorMessage(err) || "The compliance audit could not be executed.");
    } finally {
      setRunningCompliance(false);
    }
  };

  const getEventIcon = (eventType: string) => {
    switch (eventType) {
      case "package_created":
        return <Layers className="w-4 h-4 text-slate-300" />;
      case "rfq_dispatched":
        return <Send className="w-4 h-4 text-sky-400" />;
      case "rfi_clarified":
        return <MessageSquareCode className="w-4 h-4 text-emerald-400" />;
      case "bid_leveled":
        return <Scale className="w-4 h-4 text-amber-400" />;
      case "contract_awarded":
        return <Award className="w-4 h-4 text-emerald-400" />;
      case "compliance_audit":
        return <ShieldCheck className="w-4 h-4 text-purple-400" />;
      case "bid_ingest_failed":
      case "rfq_email_failed":
        return <AlertTriangle className="w-4 h-4 text-rose-400" />;
      case "cron_executed":
        return <Clock className="w-4 h-4 text-amber-300" />;
      case "file_uploaded":
        return <FileText className="w-4 h-4 text-blue-400" />;
      default:
        return <CheckCircle2 className="w-4 h-4 text-slate-400" />;
    }
  };

  const getEventBadge = (eventType: string) => {
    switch (eventType) {
      case "package_created":
        return "bg-slate-800 text-slate-200 border-slate-600";
      case "contract_awarded":
        return "bg-emerald-950/80 text-emerald-300 border-emerald-800/60";
      case "bid_leveled":
        return "bg-amber-950/80 text-amber-300 border-amber-800/60";
      case "compliance_audit":
        return "bg-purple-950/80 text-purple-300 border-purple-800/60";
      case "cron_executed":
        return "bg-yellow-950/80 text-yellow-300 border-yellow-800/60";
      case "rfq_dispatched":
        return "bg-sky-950/80 text-sky-300 border-sky-800/60";
      case "bid_ingest_failed":
      case "rfq_email_failed":
        return "bg-rose-950/80 text-rose-300 border-rose-800/60";
      default:
        return "bg-slate-800 text-slate-300 border-slate-700";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <h2 className="text-lg font-bold text-white tracking-tight">
              Live Reactive Activity Audit Stream
            </h2>
            <span className="text-[10px] font-mono bg-emerald-950 text-emerald-400 border border-emerald-800 px-2 py-0.5 rounded-full">
              useQuery WebSocket Feed
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Immutable causal audit log tracking all trade RFQs, pre-bid RFI clarifications, forensic bid leveling calculations, A401-style subcontract drafts, and Convex cron executions.
          </p>
        </div>

        {/* Cron Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            disabled={runningDeadline}
            onClick={handleRunDeadlineCron}
            className="bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 transition"
            title="Execute Convex deadline monitoring cron job"
          >
            {runningDeadline ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-400" />
            ) : (
              <Play className="w-3.5 h-3.5 text-amber-400" />
            )}
            Run Deadline Cron
          </button>

          <button
            disabled={runningCompliance}
            onClick={handleRunComplianceCron}
            className="bg-slate-800 hover:bg-slate-750 text-slate-200 border border-slate-700 text-xs font-semibold px-3 py-2 rounded-lg flex items-center gap-1.5 transition"
            title="Execute Convex contractor compliance sweep cron job"
          >
            {runningCompliance ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-purple-400" />
            ) : (
              <ShieldCheck className="w-3.5 h-3.5 text-purple-400" />
            )}
            Run Compliance Sweep
          </button>
        </div>
      </div>

      {cronError && (
        <div className="rounded-xl border border-rose-800/80 bg-rose-950/40 p-3 text-xs text-rose-300" role="alert">
          Cron execution failed: {cronError}
        </div>
      )}

      {/* Convex Cron Scheduled Status Banner */}
      {cronStatusData && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cronStatusData.activeCrons.map((cron: any) => (
            <div
              key={cron.name}
              className="bg-slate-900 border border-slate-800/80 rounded-xl p-4 flex items-center justify-between gap-3 text-xs"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-slate-850 border border-slate-700 flex items-center justify-center text-amber-400">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="font-bold text-white font-mono text-[11px]">{cron.name}</h4>
                  <p className="text-[11px] text-slate-400">{cron.description}</p>
                </div>
              </div>
              <span className="text-[10px] font-mono font-bold bg-amber-950/70 text-amber-300 border border-amber-800/60 px-2 py-0.5 rounded-full shrink-0">
                {cron.schedule}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Audit Log Stream Feed */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-200 flex items-center gap-2">
            <Clock className="w-4 h-4 text-emerald-400" />
            Activity Events ({logs.length})
          </span>
          <span className="text-slate-400 font-mono text-[11px]">
            Convex Realtime Subscriptions (Zero Polling Invariant)
          </span>
        </div>

        {logs.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            No activity records in audit stream yet. Dispatched RFQs, answered RFIs, and leveling calculations will stream in automatically.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {logs.map((log) => (
              <div
                key={log._id}
                className="p-4 sm:px-6 flex items-start gap-4 hover:bg-slate-850/40 transition"
              >
                <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0 mt-0.5">
                  {getEventIcon(log.eventType)}
                </div>

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h4 className="text-xs font-bold text-white">{log.title}</h4>
                      <span
                        className={`text-[10px] font-semibold border px-2 py-0.5 rounded-full uppercase tracking-wider font-mono ${getEventBadge(
                          log.eventType
                        )}`}
                      >
                        {log.eventType.replace(/_/g, " ")}
                      </span>
                    </div>

                    <span className="text-[11px] text-slate-400 font-mono flex items-center gap-1" title="Local time with timezone">
                      <Calendar className="w-3 h-3 text-slate-400" />
                      {formatFullDateTime(log.timestamp)}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">
                    {log.description}
                  </p>

                  <div className="text-[11px] text-slate-400 flex items-center gap-1.5 pt-0.5">
                    <span>Actor:</span>
                    <span className="text-slate-400 font-medium">{log.actor}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
