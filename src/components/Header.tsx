import { getErrorMessage } from "../lib/errors.ts";
import { validateNewProjectFields } from "../lib/newProjectValidation.ts";
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../lib/useDialogFocus.ts";
import {
  Building2,
  Layers,
  Search,
  MessageSquareCode,
  Scale,
  Activity,
  Zap,
  Radio,
  Plus,
  ChevronDown,
  Clock,
  ShieldCheck,
  FileCheck,
  Split,
  Trash2,
  Tv,
} from "lucide-react";
import { Project } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export const OPEN_NEW_PROJECT_EVENT = "tradepulse:open-new-project";

interface HeaderProps {
  projects?: Project[];
  currentProject: Project | null;
  onSelectProject?: (projectId: string) => void;
  onCreateProject?: (proj: {
    title: string;
    location: string;
    projectType: string;
    estBudget: number;
    targetCompletionWeeks: number;
    specDocumentText: string;
    isDemoProject: boolean;
    generalContractorName?: string;
  }) => Promise<void>;
  onDeleteProject?: (projectId: string) => Promise<void>;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenSimulation: () => void;
  isStandaloneMode?: boolean;
  clashCount?: number;
  isTourOpen?: boolean;
  onToggleTour?: () => void;
  packagesCount?: number;
  contractorsCount?: number;
  conversationsCount?: number;
  bidsCount?: number;
  awardedCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  projects = [],
  currentProject,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  activeTab,
  setActiveTab,
  onOpenSimulation,
  isStandaloneMode = false,
  clashCount = 0,
  isTourOpen = false,
  onToggleTour,
  packagesCount = 0,
  contractorsCount = 0,
  conversationsCount = 0,
  bidsCount = 0,
  awardedCount = 0,
}) => {
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newType, setNewType] = useState("");
  const [newBudget, setNewBudget] = useState("");
  const [newWeeks, setNewWeeks] = useState("");
  const [newSpec, setNewSpec] = useState("");
  const [newGeneralContractor, setNewGeneralContractor] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Synchronous guard: React's `disabled` prop only applies on the next render,
  // so a rapid double-click can fire the submit twice before that render lands.
  const createInFlightRef = useRef(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const newProjectDialogRef = useDialogFocus<HTMLDivElement>(isNewProjectModalOpen);

  // Keyboard shortcut listener for 1-6 keys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input or textarea
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        document.activeElement?.tagName === "SELECT"
      ) {
        return;
      }
      // Don't trigger if modifier keys are pressed (e.g. Ctrl+1 to switch browser tabs)
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      if (e.key === "1") setActiveTab("packages");
      else if (e.key === "2") setActiveTab("discovery");
      else if (e.key === "3") setActiveTab("qna");
      else if (e.key === "4") setActiveTab("leveling");
      else if (e.key === "5") setActiveTab("coordination");
      else if (e.key === "6") setActiveTab("contracts");
      else if (e.key === "7") setActiveTab("audit");
      else if (e.key === "8") setActiveTab("diagnostics");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setActiveTab]);

  // The empty-state "Create your first project" button outside the header opens the same dialog.
  useEffect(() => {
    const open = () => setIsNewProjectModalOpen(true);
    window.addEventListener(OPEN_NEW_PROJECT_EVENT, open);
    return () => window.removeEventListener(OPEN_NEW_PROJECT_EVENT, open);
  }, []);

  useEffect(() => {
    if (!isNewProjectModalOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) setIsNewProjectModalOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [creating, isNewProjectModalOpen]);

  const pipelineStages = [
    {
      id: "packages",
      step: "01",
      label: "CSI Scoping",
      sublabel: "MasterFormat",
      icon: Layers,
      badge: `${packagesCount} Pkgs`,
    },
    {
      id: "discovery",
      step: "02",
      label: "Discovery",
      sublabel: "Firecrawl SERP",
      icon: Search,
      badge: `${contractorsCount} Subs`,
    },
    {
      id: "qna",
      step: "03",
      label: "Pre-Bid Q&A",
      sublabel: "AI Addenda",
      icon: MessageSquareCode,
      badge: `${conversationsCount} RFIs`,
    },
    {
      id: "leveling",
      step: "04",
      label: "Bid Leveling",
      sublabel: "ADR-0003",
      icon: Scale,
      badge: `${bidsCount} Bids`,
    },
    {
      id: "coordination",
      step: "05",
      label: "Scope Clash",
      sublabel: "Coordination",
      icon: Split,
      badge: clashCount > 0 ? `${clashCount} Clashes` : "Clear",
      badgeColor: clashCount > 0 ? "bg-amber-950 text-amber-300 border-amber-800" : "bg-emerald-950 text-emerald-400 border-emerald-800",
    },
    {
      id: "contracts",
      step: "06",
      label: "Subcontracts",
      sublabel: "A401-style",
      icon: FileCheck,
      badge: `${awardedCount}/${packagesCount} Awarded`,
    },
  ];

  const utilityTabs = [
    { id: "audit", label: "Live Activity Audit", icon: Clock },
    { id: "diagnostics", label: "Evals & Architecture", icon: Activity },
  ];

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createInFlightRef.current) return;
    const validation = validateNewProjectFields({ title: newTitle, budget: newBudget, weeks: newWeeks });
    if (!validation.ok) {
      setCreateError(validation.error || "Please check the project fields.");
      return;
    }
    if (!onCreateProject) {
      setCreateError("Project creation is unavailable in this session.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    createInFlightRef.current = true;
    try {
      await onCreateProject({
        title: newTitle.trim(),
        location: newLocation.trim() || "Austin, TX",
        projectType: newType.trim() || "Class-A Commercial Mixed-Use",
        estBudget: validation.budget as number,
        targetCompletionWeeks: validation.weeks as number,
        specDocumentText: newSpec.trim() || `Project Scope for ${newTitle.trim()}. Standard CSI MasterFormat commercial obligations.`,
        isDemoProject: false,
        generalContractorName: newGeneralContractor.trim() || "Austin Commercial, LP",
      });
      setIsNewProjectModalOpen(false);
      setNewTitle("");
      setNewLocation("");
      setNewType("");
      setNewBudget("");
      setNewWeeks("");
      setNewSpec("");
      setNewGeneralContractor("");
    } catch (err: any) {
      setCreateError(getErrorMessage(err) || "The project could not be created.");
    } finally {
      createInFlightRef.current = false;
      setCreating(false);
    }
  };

  return (
    <header className="border-b border-slate-800 bg-slate-900/95 backdrop-blur sticky top-0 z-40 shadow-lg">
      {/* Top Banner with Sponsor Integration Badges & Presentation Mode */}
      <div className="border-b border-slate-800/80 px-4 lg:px-8 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 rounded-full" title={isStandaloneMode ? "Serving the local snapshot of the dataset because Convex is unreachable. Figures may be stale." : "Live data is streaming from the Convex deployment."}>
            <Radio className={`w-3 h-3 text-emerald-400 ${isStandaloneMode ? "" : "animate-pulse"}`} />
            {isStandaloneMode ? "Offline snapshot mode — data may be stale" : "Convex Reactive WebSockets Active"}
          </span>
          <span className="text-slate-400 hidden sm:inline">•</span>
          <span className="text-slate-400 hidden sm:inline font-mono text-[11px]">
            Convex "All Gas" Hackathon 2026
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden xl:flex items-center gap-1.5 mr-1">
            <span className="text-slate-400 text-[11px]">Sponsors:</span>
            <span className="bg-orange-950/40 text-orange-300 border border-orange-800/40 px-1.5 py-0.5 rounded text-[10px] font-mono">Convex</span>
            <span className="bg-emerald-950/40 text-emerald-300 border border-emerald-800/40 px-1.5 py-0.5 rounded text-[10px] font-mono">OpenAI</span>
            <span className="bg-amber-950/40 text-amber-300 border border-amber-800/40 px-1.5 py-0.5 rounded text-[10px] font-mono">Firecrawl</span>
            <span className="bg-blue-950/40 text-blue-300 border border-blue-800/40 px-1.5 py-0.5 rounded text-[10px] font-mono">AgentMail</span>
          </div>

          {/* Investor Demo Tour Toggle Button */}
          {onToggleTour && (
            <button
              onClick={onToggleTour}
              className={`font-bold px-2.5 py-1 rounded-lg flex items-center gap-1.5 text-xs transition border shadow-sm ${
                isTourOpen
                  ? "bg-amber-400 text-slate-950 border-amber-300 ring-2 ring-amber-400/40"
                  : "bg-slate-800 hover:bg-slate-750 text-amber-300 border-amber-500/40 hover:border-amber-400"
              }`}
              title="Toggle Investor Demo Tour Teleprompter"
            >
              <Tv className="w-3.5 h-3.5" />
              <span>🎬 Demo Tour</span>
            </button>
          )}

          <button
            onClick={onOpenSimulation}
            className="bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-slate-950 font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 shadow-sm text-xs transition"
          >
            <Zap className="w-3 h-3 fill-slate-950" />
            ⚡ 60s Judge Dock
          </button>
        </div>
      </div>

      {/* Main Header Bar */}
      <div className="px-4 lg:px-8 py-2 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 flex items-center justify-center shadow-lg shadow-emerald-500/10 border border-emerald-400/30">
            <Building2 className="w-4.5 h-4.5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-white tracking-tight flex items-center gap-1.5">
                TradePulse <span className="text-emerald-400">Pro</span>
              </h1>
              <span className="text-[10px] uppercase font-bold tracking-wider bg-slate-800 text-slate-300 border border-slate-700 px-1.5 py-0.5 rounded">
                CSI MasterFormat
              </span>
            </div>
            <p className="text-[11px] text-slate-400 hidden sm:block">
              Autonomous Subcontractor Procurement, Dynamic Pre-Bid Q&A & Real-Time Bid Leveling
            </p>
          </div>
        </div>

        {/* Project Selector & New Project Button */}
        <div className="flex items-center gap-2">
          {projects.length > 0 && onSelectProject && (
            <div className="relative">
              <select
                value={currentProject?._id ?? ""}
                onChange={(e) => onSelectProject(e.target.value)}
                aria-label="Select Commercial Construction Project"
                className="bg-slate-850 border border-slate-700 hover:border-slate-600 text-slate-200 text-xs rounded-lg pl-3 pr-8 py-1.5 focus:outline-none focus:border-emerald-500 font-medium appearance-none cursor-pointer max-w-[130px] sm:max-w-xs truncate"
                title={projects.map((p) => `${p.title} (${p.location})`).join("\n")}
              >
                {projects.map((p) => (
                  <option key={p._id} value={p._id} className="bg-slate-900 text-white">
                    {p.title} ({p.location})
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2.5 pointer-events-none" />
            </div>
          )}

          <button
            onClick={() => {
              setCreateError(null);
              // A18-01: a cancelled draft must not leak into the next project.
              setNewTitle("");
              setNewLocation("");
              setNewType("");
              setNewBudget("");
              setNewWeeks("");
              setNewSpec("");
              setNewGeneralContractor("");
              setIsNewProjectModalOpen(true);
            }}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 hover:border-slate-600 text-xs font-semibold px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 transition shadow-sm"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            <span>New Project</span>
          </button>

          {currentProject && !currentProject.isDemoProject && onDeleteProject && (
            <button
              onClick={() => setIsDeleteConfirmOpen(true)}
              className="bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 border border-slate-700 hover:border-rose-800/60 text-xs font-semibold px-2 py-1.5 rounded-lg flex items-center gap-1 transition shadow-sm"
              title="Delete custom project"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden sm:inline">Delete</span>
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={isDeleteConfirmOpen}
        title="Delete project?"
        description={`This permanently removes ${currentProject?.title || "this project"} and its trade packages, bids, agreements, and files.`}
        confirmLabel="Delete project"
        onCancel={() => setIsDeleteConfirmOpen(false)}
        onConfirm={async () => {
          if (currentProject && onDeleteProject) {
            await onDeleteProject(currentProject._id);
          }
          setIsDeleteConfirmOpen(false);
        }}
      />

      {/* Procurement Pipeline Stepper & Navigation */}
      <div className="px-4 lg:px-8 flex flex-wrap items-center justify-between border-t border-slate-800/80 bg-slate-950/50 gap-2 min-w-0">
        <label className="sm:hidden flex items-center gap-2 py-2 text-[11px] font-semibold text-slate-400 shrink-0">
          Stage
          <select
            value={activeTab}
            onChange={(event) => setActiveTab(event.target.value)}
            aria-label="Navigate procurement stage"
            className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-200 font-medium"
          >
            {[...pipelineStages.map((stage) => ({ id: stage.id, label: stage.label })), ...utilityTabs].map((tab) => (
              <option key={tab.id} value={tab.id}>{tab.label}</option>
            ))}
          </select>
        </label>
        {/* 6-Stage Pipeline Stepper */}
        <div className="hidden sm:flex flex-wrap items-center gap-1 py-1 min-w-0 flex-1">
          {pipelineStages.map((stage, idx) => {
            const Icon = stage.icon;
            const isActive = activeTab === stage.id;
            const isCompleted =
              (stage.id === "packages" && packagesCount > 0) ||
              (stage.id === "discovery" && contractorsCount > 0) ||
              (stage.id === "qna" && conversationsCount > 0) ||
              (stage.id === "leveling" && bidsCount > 0) ||
              (stage.id === "coordination" && clashCount === 0 && awardedCount > 0) ||
              (stage.id === "contracts" && awardedCount > 0);
            return (
              <React.Fragment key={stage.id}>
                <button
                  onClick={() => setActiveTab(stage.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={`group flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition whitespace-nowrap ${
                    isActive
                      ? "bg-slate-800 text-white shadow-sm ring-1 ring-emerald-500/60"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-850/60"
                  }`}
                  title={`${stage.step}: ${stage.label} - ${stage.sublabel} (Press ${idx + 1})`}
                >
                  <span
                    className={`text-[10px] font-mono px-1 py-0.5 rounded font-bold transition flex items-center justify-center min-w-[18px] ${
                      isActive
                        ? "bg-emerald-500 text-slate-950 shadow-sm"
                        : isCompleted
                        ? "bg-emerald-950 text-emerald-400 border border-emerald-800/80"
                        : "bg-slate-800 text-slate-400 group-hover:text-slate-200"
                    }`}
                  >
                    {isCompleted && !isActive ? "✓" : stage.step}
                  </span>
                  <Icon
                    className={`w-3.5 h-3.5 ${isActive ? "text-emerald-400" : isCompleted ? "text-emerald-500/80" : "text-slate-400 group-hover:text-slate-300"}`}
                  />
                  <span className={isActive ? "text-white font-bold" : ""}>{stage.label}</span>

                  {stage.badge && (
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded border font-medium ${
                        stage.badgeColor ||
                        (isActive
                          ? "bg-emerald-950/80 text-emerald-300 border-emerald-700/60"
                          : "bg-slate-900 text-slate-400 border-slate-700/60")
                      }`}
                    >
                      {stage.badge}
                    </span>
                  )}
                </button>

                {idx < pipelineStages.length - 1 && (
                  <span className="text-slate-700 select-none text-xs">›</span>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Secondary Auxiliary Utilities (Audit & Diagnostics) */}
        <div className="hidden sm:flex items-center gap-1 py-1 border-l border-slate-800/80 pl-2 shrink-0">
          {utilityTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg transition whitespace-nowrap ${
                  isActive
                    ? "bg-slate-800 text-emerald-400 font-semibold ring-1 ring-slate-700"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-850/60"
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? "text-emerald-400" : "text-slate-400"}`} />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* New Project Modal */}
      {isNewProjectModalOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in overflow-y-auto"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !creating) setIsNewProjectModalOpen(false);
            }}
          >
            <div
              ref={newProjectDialogRef}
              className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-4 my-auto max-h-[90vh] overflow-y-auto"
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-project-title"
            >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 id="new-project-title" className="text-base font-bold text-white flex items-center gap-2">
                <Building2 className="w-5 h-5 text-emerald-400" />
                Create New Construction Project
              </h3>
              <button
                onClick={() => setIsNewProjectModalOpen(false)}
                aria-label="Close new project dialog"
                className="text-slate-400 hover:text-white text-xs font-mono"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-400 font-medium mb-1">Project Title</label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  aria-label="Project title"
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Austin Innovation Tower - Phase II"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Location</label>
                  <input
                    type="text"
                    required
                    value={newLocation}
                    aria-label="Project location"
                    onChange={(e) => setNewLocation(e.target.value)}
                    placeholder="e.g. Austin, TX"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Project Type</label>
                  <input
                    type="text"
                    required
                    value={newType}
                    aria-label="Project type"
                    onChange={(e) => setNewType(e.target.value)}
                    placeholder="e.g. Healthcare / Mixed-Use"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">General Contractor / Contracting Entity</label>
                <input
                  type="text"
                  required
                  value={newGeneralContractor}
                  aria-label="General contractor or contracting entity"
                  onChange={(e) => setNewGeneralContractor(e.target.value)}
                  placeholder="e.g. Austin Commercial, LP"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Estimated Budget ($)</label>
<input
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 5500000"
                  value={newBudget}
                  onChange={(e) => setNewBudget(e.target.value)}
                  aria-label="Estimated budget in dollars"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono"
                />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Duration (Weeks)</label>
<input
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 52"
                  value={newWeeks}
                  onChange={(e) => setNewWeeks(e.target.value)}
                  aria-label="Target completion duration in weeks"
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 font-mono"
                />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Specification Summary</label>
                <textarea
                  rows={3}
                  value={newSpec}
                  onChange={(e) => setNewSpec(e.target.value)}
                  placeholder="Outline high-level trade scopes, design criteria, and mandatory inclusions..."
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
                {createError && <p role="alert" className="mr-auto max-w-[55%] text-[11px] text-rose-400">{createError}</p>}
                <button
                  type="button"
                  onClick={() => setIsNewProjectModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-semibold rounded-lg transition flex items-center gap-1.5"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {creating ? "Creating Project..." : "Create Commercial Project"}
                </button>
              </div>
            </form>
            </div>
          </div>,
          document.body
        )}
    </header>
  );
};
