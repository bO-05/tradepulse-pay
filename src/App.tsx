import { getErrorMessage } from "./lib/errors.ts";
import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../convex/_generated/api.js";
import { Header, OPEN_NEW_PROJECT_EVENT } from "./components/Header.tsx";
import { Button, EmptyState } from "./ui";
import { ExecutiveKpiBar } from "./components/ExecutiveKpiBar.tsx";
import { TradePackagesView } from "./components/TradePackagesView.tsx";
import { SubcontractorDiscoveryView } from "./components/SubcontractorDiscoveryView.tsx";
import { PreBidQnAView } from "./components/PreBidQnAView.tsx";
import { BidLevelingMatrixView } from "./components/BidLevelingMatrixView.tsx";
import { CrossTradeCoordinationView } from "./components/CrossTradeCoordinationView.tsx";
import { ContractsRegisterView } from "./components/ContractsRegisterView.tsx";
import { ActivityAuditStreamView } from "./components/ActivityAuditStreamView.tsx";
import { ProjectFilesView } from "./components/ProjectFilesView.tsx";
import { SponsorDiagnosticsView } from "./components/SponsorDiagnosticsView.tsx";
import { JudgeSimulationDock } from "./components/JudgeSimulationDock.tsx";
import { InvestorDemoTourBar } from "./components/InvestorDemoTourBar.tsx";
import {
  Project,
  TradePackage,
  Contractor,
  Conversation,
  Bid,
  ProjectFile,
  DoubleBuyClash,
  ScopeVoidClash,
  Agreement,
  AuditLog,
  ScopeExclusion,
  ValueEngineeringAlternate,
} from "./types.ts";
import { computeProcurementMetrics, getEffectiveBid } from "./leveling.ts";
import { useActiveCompany } from "./auth/companyContext.ts";

/**
 * A6-35: honest defaults for quote-created contractors. A company named in a
 * proposal never inherits another company's contact email, license number, or
 * verification badge; the GC supplies those before the record is used.
 */
const UNPUBLISHED_CONTRACTOR_FIELDS = {
  contactEmail: "not-published@verify-required.invalid",
  licenseNumber: "Not verified",
  licenseStatus: "Unverified - quote intake",
  sourceUrl: "",
};

const NO_PROJECT_MESSAGE = "Select or create a project first.";

/** Keys of the retired browser-side data store; cleared so old snapshots never come back. */
const RETIRED_STORAGE_PREFIXES = ["tradepulse_standalone"];

function purgeRetiredStorage() {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key && RETIRED_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

const VALID_TABS = [
  "packages",
  "discovery",
  "qna",
  "leveling",
  "coordination",
  "contracts",
  "audit",
  "diagnostics",
] as const;

function readUrlState(key: "project" | "tab"): string {
  if (typeof window === "undefined") return "";
  try {
    const value = new URLSearchParams(window.location.search).get(key) || "";
    if (key === "tab") {
      return (VALID_TABS as readonly string[]).includes(value) ? value : "";
    }
    return value;
  } catch {
    return "";
  }
}

function readStoredSelection(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

/** `undefined` from useQuery means "still loading"; screens render an empty list meanwhile. */
function live<T>(value: T[] | undefined): T[] {
  return value ?? [];
}

export const App: React.FC = () => {
  const company = useActiveCompany();
  const isDemo = company.isDemo;
  const [activeTab, setActiveTab] = useState<string>(() => readUrlState("tab") || "packages");
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    () => readUrlState("project") || readStoredSelection("tradepulse.selectedProjectId")
  );
  const [selectedPackageId, setSelectedPackageId] = useState<string>(() => readStoredSelection("tradepulse.selectedPackageId"));
  const [isSimulationOpen, setIsSimulationOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<"success" | "error" | "info">("success");
  const [isTourOpen, setIsTourOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("tradepulse.tourDismissed") !== "1";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    purgeRetiredStorage();
  }, []);

  const projectsData = useQuery(api.projects.listProjects, {});
  const isProjectsLoading = projectsData === undefined;
  const projects: Project[] = (projectsData as Project[] | undefined) ?? [];

  const currentProject: Project | null =
    projects.find((p) => p._id === selectedProjectId) ?? projects[0] ?? null;

  const isRealConvexProject = Boolean(currentProject);

  // A project id from the URL or storage that is not in this account's list (another account's
  // project, or a deleted one) is dropped instead of lingering in the address bar.
  useEffect(() => {
    if (isProjectsLoading) return;
    if (projects.some((project) => project._id === selectedProjectId)) return;
    const preferred = projects.find((project) => (project as any).isDemoProject) ?? projects[0];
    setSelectedProjectId(preferred?._id ?? "");
  }, [projects, selectedProjectId, isProjectsLoading]);

  useEffect(() => {
    try {
      if (selectedProjectId) window.localStorage.setItem("tradepulse.selectedProjectId", selectedProjectId);
      else window.localStorage.removeItem("tradepulse.selectedProjectId");
      if (selectedPackageId) window.localStorage.setItem("tradepulse.selectedPackageId", selectedPackageId);
      else window.localStorage.removeItem("tradepulse.selectedPackageId");
    } catch {
      // Local persistence is best-effort in restricted browser contexts.
    }
  }, [selectedProjectId, selectedPackageId]);

  // Deep-link/history sync: project + tab live in the URL so selections are shareable
  // and the browser Back/Forward buttons navigate between them.
  useEffect(() => {
    if (isProjectsLoading) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const urlProject = params.get("project");
      if (selectedProjectId) params.set("project", selectedProjectId);
      else params.delete("project");
      if (activeTab) params.set("tab", activeTab);
      const query = params.toString();
      const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
        const isCorrection = Boolean(urlProject) && urlProject !== selectedProjectId && !projects.some((p) => p._id === urlProject);
        if (isCorrection) window.history.replaceState(null, "", next);
        else window.history.pushState(null, "", next);
      }
    } catch {
      // URL sync is best-effort in restricted browser contexts.
    }
  }, [selectedProjectId, activeTab, isProjectsLoading, projects]);

  useEffect(() => {
    const handlePopState = () => {
      const urlProject = readUrlState("project");
      const urlTab = readUrlState("tab");
      setSelectedProjectId((prev) => urlProject || prev);
      if (urlTab) setActiveTab(urlTab);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Trade packages
  const tradePackagesData = useQuery(
    api.tradePackages.listByProject,
    currentProject ? { projectId: currentProject._id as any } : "skip"
  );
  const tradePackages: TradePackage[] = live(tradePackagesData as TradePackage[] | undefined);
  const tradePackagesLoading = Boolean(currentProject) && tradePackagesData === undefined;

  // Determine active package
  const activePackage: TradePackage | null =
    tradePackages.find((p) => p._id === selectedPackageId) ?? tradePackages[0] ?? null;

  const isRealConvexPackage = Boolean(activePackage);

  useEffect(() => {
    if (isProjectsLoading) return;
    // A18-02: do not clear the persisted package selection while the package
    // list is still loading, or a reload silently reverts to Package 01.
    if (tradePackagesLoading) return;
    if (tradePackages.length === 0) {
      if (selectedPackageId !== "") {
        setSelectedPackageId("");
      }
    } else if (!selectedPackageId || !tradePackages.some((p) => p._id === selectedPackageId)) {
      setSelectedPackageId(tradePackages[0]._id);
    }
  }, [tradePackages, selectedPackageId, isProjectsLoading, tradePackagesLoading]);

  const packageArgs = activePackage ? { tradePackageId: activePackage._id as any } : "skip";
  const projectArgs = currentProject ? { projectId: currentProject._id as any } : "skip";

  const contractors: Contractor[] = live(useQuery(api.contractors.listByPackage, packageArgs) as Contractor[] | undefined);
  const conversations: Conversation[] = live(useQuery(api.rfq.listConversations, packageArgs) as Conversation[] | undefined);
  const bids: Bid[] = live(useQuery(api.bids.listByPackage, packageArgs) as Bid[] | undefined);
  // Project-wide bids for the procurement KPI bar
  const allProjectBids: Bid[] = live(useQuery(api.bids.listAllProjectBids, projectArgs) as Bid[] | undefined);

  // Cross-trade scope clash data
  const clashesData = useQuery(api.coordination.detectCrossTradeClashes, projectArgs);
  const doubleBuys: DoubleBuyClash[] = live((clashesData as any)?.doubleBuys as DoubleBuyClash[] | undefined);
  const scopeVoids: ScopeVoidClash[] = live((clashesData as any)?.scopeVoids as ScopeVoidClash[] | undefined);

  const activeClashesCount =
    doubleBuys.filter((d) => d.status === "detected").length +
    scopeVoids.filter((v) => v.status === "open").length;

  const projectFiles: ProjectFile[] = live(useQuery(api.files.listFilesByProject, projectArgs) as ProjectFile[] | undefined);
  const agreements: Agreement[] = live(useQuery(api.agreements.listAgreements, projectArgs) as Agreement[] | undefined);

  // Single source of truth for every headline procurement figure (KPI bar, stepper, tour).
  const procurementMetrics = useMemo(
    () => computeProcurementMetrics(currentProject, tradePackages, allProjectBids, agreements),
    [currentProject, tradePackages, allProjectBids, agreements]
  );

  // Live context for the demo tour so scene narration always matches the screen.
  const tourLiveContext = useMemo(() => {
    const sortedBids = [...bids].sort((a, b) => a.leveledTotalCost - b.leveledTotalCost);
    const effective = getEffectiveBid(sortedBids);
    const runnerUp = sortedBids.find((bid) => bid._id !== effective?._id);
    const activeAgreement = agreements.find((a) => a.status !== "superseded");
    return {
      projectTitle: currentProject?.title || "the active project",
      packagesCount: tradePackages.length,
      contractorsCount: contractors.length,
      conversationsCount: conversations.length,
      bidsCount: bids.length,
      agreementsCount: agreements.filter((a) => a.status !== "superseded").length,
      awardedPackages: procurementMetrics.awardedPackages,
      totalPackages: procurementMetrics.totalPackages,
      totalBudget: procurementMetrics.totalBudget,
      totalLeveledBuyout: procurementMetrics.totalLeveledBuyout,
      variance: procurementMetrics.variance,
      gapsCaught: procurementMetrics.gapsCaught,
      deceptiveBidsCount: procurementMetrics.deceptiveBidsCount,
      openClashes: activeClashesCount,
      effectiveBidName: effective?.subcontractorName,
      effectiveBidCost: effective?.leveledTotalCost,
      runnerUpName: runnerUp?.subcontractorName,
      runnerUpCost: runnerUp?.leveledTotalCost,
      runnerUpBaseCost: runnerUp?.baseBidAmount,
      contractSum: activeAgreement?.contractSum,
      contractExecuted: activeAgreement?.status === "executed",
      hasBids: bids.length > 0,
    };
  }, [bids, agreements, currentProject, tradePackages, contractors, conversations, procurementMetrics, activeClashesCount]);

  const auditLogs: AuditLog[] = live(
    useQuery(api.auditLogs.listRecentLogs, currentProject ? { projectId: currentProject._id as any, limit: 100 } : "skip") as
      | AuditLog[]
      | undefined
  );

  // Convex Mutations & Actions
  const seedDataMutation = useMutation(api.projects.seedInitialData);
  const createProjectMutation = useMutation(api.projects.createProject);
  const deleteProjectMutation = useMutation(api.projects.deleteProject);
  const createPackageMutation = useMutation(api.tradePackages.createTradePackage);
  const deletePackageMutation = useMutation(api.tradePackages.deleteTradePackage);
  const dispatchRfqsAction = useAction(api.rfqActions.dispatchRfqsWithNotification);
  const dispatchSingleRfqAction = useAction(api.rfqActions.dispatchSingleRfqWithNotification);
  const generateAgreementMutation = useMutation(api.agreements.generateAgreement);
  const triggerSimulationMutation = useMutation(api.simulation.triggerJudgeSimulation);
  const submitCustomRfiMutation = useMutation(api.simulation.submitCustomRfi);
  const retryRfiAnalysisMutation = useMutation(api.simulation.retryRfiAnalysis);
  const discoverAction = useAction(api.contractorDiscovery.discoverSubcontractors);
  const deductDoubleBuyCreditMutation = useMutation(api.coordination.deductDoubleBuyCredit);
  const reverseDoubleBuyCreditMutation = useMutation(api.coordination.reverseDoubleBuyCredit);
  const assignScopeVoidToTradeMutation = useMutation(api.coordination.assignScopeVoidToTrade);
  const reviewEscalatedRfiMutation = useMutation(api.rfq.reviewEscalatedRfi);
  const generateTradePackagesAction = useAction(api.tradePackages.generateTradePackagesFromSpec);
  const extractBidAction = useAction(api.files.extractBidFromQuoteFile);
  const scanCrossTradeClashesAction = useAction(api.coordination.scanCrossTradeClashes);
  const runFullCycleMutation = useMutation(api.simulation.runFullProcurementCycle);
  const updateAdjustmentsMutation = useMutation(api.bids.updateBidAdjustments);
  const unawardContractMutation = useMutation(api.bids.unawardContract);
  const deleteBidMutation = useMutation(api.bids.deleteBid);
  const executeAgreementMutation = useMutation(api.agreements.executeAgreement);
  const createContractorMutation = useMutation(api.contractors.createContractor);
  const updateContractorMutation = useMutation(api.contractors.updateContractor);
  const deleteContractorMutation = useMutation(api.contractors.deleteContractor);
  const runDeadlineMutation = useMutation(api.crons.runDeadlineMonitorNow);
  const runComplianceMutation = useMutation(api.crons.runComplianceAuditNow);

  // Global drag-and-drop preventer to prevent browser navigating away when dropping files outside drop targets
  useEffect(() => {
    const preventDragOver = (e: DragEvent) => e.preventDefault();
    const preventDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", preventDragOver);
    window.addEventListener("drop", preventDrop);
    return () => {
      window.removeEventListener("dragover", preventDragOver);
      window.removeEventListener("drop", preventDrop);
    };
  }, []);

  const showToast = (msg: string, tone: "success" | "error" | "info" = "success") => {
    setToastMessage(msg);
    setToastTone(tone);
    setTimeout(() => setToastMessage(null), 4500);
  };

  // Handlers
  const handleDispatchRfqs = async (packageId: string) => {
    try {
      const isRealPkg = isRealConvexProject && Boolean(packageId) && !packageId.startsWith("pkg_");
      if (isRealPkg) {
        const res = await dispatchRfqsAction({ tradePackageId: packageId as any });
        if (!res || res.dispatchedCount === 0) {
          showToast("No RFQ invitations were sent: no contractors require dispatch for this package.", "error");
        } else if (res.emailsSent > 0) {
          showToast(`RFQs delivered to ${res.emailsSent} contractor(s) via AgentMail.`, "success");
        } else if (res.deliveryConfigured === false) {
          showToast(
            `RFQs recorded for ${res.dispatchedCount} contractor(s), but AgentMail is not configured on this deployment, so no email left the system.`,
            "info"
          );
        } else {
          const firstFailure = Array.isArray(res.deliveryFailures) && res.deliveryFailures.length > 0 ? ` First issue: ${res.deliveryFailures[0]}` : "";
          showToast(`RFQs recorded for ${res.dispatchedCount} contractor(s), but no email was delivered.${firstFailure}`, "error");
        }
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
    } catch (err: any) {
      showToast(`RFQ dispatch failed: ${getErrorMessage(err) || "No invitations were confirmed."}`, "error");
    }
  };

  const handleCreateProject = async (proj: {
    title: string;
    location: string;
    projectType: string;
    estBudget: number;
    targetCompletionWeeks: number;
    specDocumentText: string;
    isDemoProject: boolean;
    generalContractorName?: string;
  }) => {
    try {
      const newId: any = await createProjectMutation(proj);
      setSelectedProjectId(newId);
      showToast(`Project '${proj.title}' created.`);
    } catch (err: any) {
      showToast(`Error creating project: ${getErrorMessage(err)}`);
      throw err;
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    try {
      const isRealProj = isRealConvexProject && Boolean(projectId) && !projectId.startsWith("proj_");
      if (isRealProj) {
        await deleteProjectMutation({ projectId: projectId as any });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      const remaining = projects.filter((p) => p._id !== projectId);
      setSelectedProjectId(remaining[0]?._id || "");
      showToast("Project deleted successfully.");
    } catch (err: any) {
      showToast(`Delete project: ${getErrorMessage(err) || "Error"}`);
      throw err;
    }
  };

  const handleCreatePackage = async (pkg: {
    csiDivision: string;
    tradeName: string;
    budgetEstimate: number;
    scopeSummary: string;
    mandatoryInclusions: string[];
    bidDeadline: string;
  }) => {
    if (!currentProject) return;
    try {
      if (isRealConvexProject && !currentProject._id.startsWith("proj_")) {
        const createdPkgId = await createPackageMutation({
          projectId: currentProject._id as any,
          ...pkg,
        });
        if (createdPkgId) {
          setSelectedPackageId(createdPkgId as string);
        }
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(`CSI Division ${pkg.csiDivision} (${pkg.tradeName}) created successfully.`);
    } catch (err: any) {
      showToast(`Error creating package: ${getErrorMessage(err)}`);
      throw err;
    }
  };

  const handleDeletePackage = async (packageId: string) => {
    try {
      const targetPkg = tradePackages.find((p) => p._id === packageId);
      if (!targetPkg) return;
      if (isRealConvexProject && !packageId.startsWith("pkg_")) {
        await deletePackageMutation({ tradePackageId: packageId as any });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      if (selectedPackageId === packageId) {
        const remaining = tradePackages.filter((p) => p._id !== packageId);
        setSelectedPackageId(remaining[0]?._id || "");
      }
      showToast(`Deleted trade package ${targetPkg.tradeName}`);
    } catch (err: any) {
      showToast(`Error deleting trade package: ${getErrorMessage(err) || err}`);
      throw err;
    }
  };

  const handleGeneratePackagesFromSpec = async (
    specText: string,
    opts?: { previewOnly?: boolean; confirmedPackages?: any[] }
  ): Promise<{ packagesCount: number; packages?: any[] }> => {
    if (!currentProject) return { packagesCount: 0 };
    try {
      if (isRealConvexProject && !currentProject._id.startsWith("proj_")) {
        const res = await Promise.race([
          generateTradePackagesAction({
            projectId: currentProject._id as any,
            specDocumentTextOverride: specText,
            previewOnly: opts?.previewOnly,
            confirmedPackages: opts?.confirmedPackages as any,
          }),
          new Promise<never>((_, reject) =>
            window.setTimeout(
              () =>
                reject(
                  new Error(
                    "The autonomous CSI breakdown is taking longer than expected (AI pipeline timeout after 150s). Try again, or create the trade packages manually."
                  )
                ),
              150000
            )
          ),
        ]);
        return { packagesCount: res.packagesCount, packages: (res as any).packages };
      }

      throw new Error(NO_PROJECT_MESSAGE);
    } catch (err) {
      throw err;
    }
  };

  const handleDiscover = async (packageId: string) => {
    try {
      const isRealPkg = isRealConvexProject && Boolean(packageId) && !packageId.startsWith("pkg_");
      if (isRealPkg) {
        const res = await discoverAction({ tradePackageId: packageId as any });
        if (res.discoveredCount === 0) {
          showToast(
            "No usable contractor pages were found by live web discovery. Try a different project location or add a contractor manually.",
            "info"
          );
        } else {
          showToast(`Discovered ${res.discoveredCount} contractor record(s) via live web search. Review provenance before inviting.`, "success");
        }
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
    } catch (err: any) {
      showToast(`Discovery failed: ${getErrorMessage(err) || "No contractors were added."}`);
      throw err;
    }
  };

  const handleDispatchIndividualRfq = async (contractorId: string) => {
    try {
      const isRealCtr = isRealConvexProject && Boolean(contractorId) && !contractorId.startsWith("ctr_");
      if (isRealCtr) {
        const res = await dispatchSingleRfqAction({
          contractorId: contractorId as any,
        });
        if (res && res.emailSent) {
          showToast("Invitation to bid delivered via AgentMail.", "success");
        } else if (res && res.deliveryConfigured === false) {
          showToast("Contractor marked invited, but AgentMail is not configured so no email was sent.", "info");
        } else {
          showToast("Contractor marked invited, but the AgentMail delivery did not succeed (check the contact email).", "error");
        }
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
    } catch (err: any) {
      showToast(`RFQ invitation failed: ${getErrorMessage(err) || "The invitation was not sent."}`);
      throw err;
    }
  };

  const handleCreateContractor = async (contractor: {
    tradePackageId: string;
    companyName: string;
    contactEmail: string;
    phone?: string;
    licenseNumber: string;
    licenseStatus: string;
    sourceUrl: string;
  }) => {
    try {
      const isRealPkg = isRealConvexProject && Boolean(contractor.tradePackageId) && !contractor.tradePackageId.startsWith("pkg_");
      if (isRealPkg) {
        await createContractorMutation({
          ...contractor,
          tradePackageId: contractor.tradePackageId as any,
          rfqStatus: "discovered",
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(`Contractor '${contractor.companyName}' added to bidding roster.`);
    } catch (err: any) {
      showToast(`Contractor add failed: ${getErrorMessage(err) || "The contractor was not saved."}`);
      throw err;
    }
  };

  const handleUpdateContractor = async (
    contractorId: string,
    updates: {
      companyName: string;
      contactEmail: string;
      phone?: string;
      licenseNumber: string;
      licenseStatus: string;
      sourceUrl: string;
      expectedUpdatedAt?: number;
    }
  ) => {
    try {
      const isRealCtr = isRealConvexProject && Boolean(contractorId) && !contractorId.startsWith("ctr_");
      if (isRealCtr) {
        await updateContractorMutation({
          contractorId: contractorId as any,
          ...updates,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(`Contractor '${updates.companyName}' details updated.`);
    } catch (err: any) {
      showToast(`Contractor update failed: ${getErrorMessage(err) || "The contractor was not updated."}`);
      throw err;
    }
  };

  const handleDeleteContractor = async (contractorId: string) => {
    try {
      const isRealCtr = isRealConvexProject && Boolean(contractorId) && !contractorId.startsWith("ctr_");
      if (isRealCtr) {
        await deleteContractorMutation({ contractorId: contractorId as any });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Contractor removed from bidding roster.");
    } catch (err: any) {
      showToast(`Contractor removal failed: ${getErrorMessage(err) || "The contractor was not removed."}`);
      throw err;
    }
  };

  const handleSubmitRfi = async (data: {
    contractorId: string;
    subject: string;
    question: string;
    tradePackageId?: string;
  }): Promise<{ conversationId?: string }> => {
    if (!activePackage || !data.question?.trim()) return {};
    const targetPackageId = data.tradePackageId || activePackage._id;
    const isCrossPackage = targetPackageId !== activePackage._id;
    try {
      const isGuestSubmitter = data.contractorId === "guest_contractor" || isCrossPackage;
      const canSubmitConvex =
        isRealConvexProject &&
        isRealConvexPackage &&
        !targetPackageId.startsWith("pkg_") &&
        !data.contractorId.startsWith("ctr_");
      if (canSubmitConvex) {
        const res = await submitCustomRfiMutation({
          tradePackageId: targetPackageId as any,
          contractorId: isGuestSubmitter ? undefined : (data.contractorId as any),
          subject: data.subject,
          question: data.question,
        });
        showToast("RFI submitted to TradePulse autonomous AI clarification engine.");
        return { conversationId: (res as any)?.conversationId };
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
    } catch (err: any) {
      showToast(`RFI clarification failed: ${getErrorMessage(err) || "The clarification was not saved."}`);
      throw err;
    }
  };

  const handleRetryRfi = async (conversationId: string) => {
    try {
      if (isRealConvexProject && conversationId && !conversationId.startsWith("conv_")) {
        const res: any = await retryRfiAnalysisMutation({ conversationId: conversationId as any });
        if (res?.success) {
          showToast("RFI re-queued for AI analysis.");
        } else {
          showToast(res?.message || "This RFI cannot be retried.");
        }
        return;
      }
      throw new Error(NO_PROJECT_MESSAGE);
    } catch (err: any) {
      showToast(`RFI retry failed: ${getErrorMessage(err) || "The RFI was not re-queued."}`);
      throw err;
    }
  };

  const handleReviewRfi = async (
    convoId: string,
    status: "clarified" | "escalated_to_pm" | "rejected",
    newReply?: string,
    note?: string
  ) => {
    try {
      const isRealConvo = isRealConvexProject && Boolean(convoId) && !convoId.startsWith("conv_");
      if (isRealConvo) {
        await reviewEscalatedRfiMutation({
          conversationId: convoId as any,
          status,
          autonomousReply: newReply,
          reviewNote: note,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(
        status === "clarified"
          ? "RFI approved & certified for inclusion in ADDENDUM NO. 01!"
          : `RFI status updated to ${status}.`
      );
    } catch (err: any) {
      showToast(`RFI review failed: ${getErrorMessage(err) || "The review was not saved."}`);
      throw err;
    }
  };

  const handleAwardContract = async (bidId: string, tradePackageId: string) => {
    try {
      const canAwardConvex =
        isRealConvexProject &&
        Boolean(bidId) &&
        !bidId.startsWith("bid_") &&
        Boolean(tradePackageId) &&
        !tradePackageId.startsWith("pkg_");
      if (canAwardConvex) {
        await generateAgreementMutation({
          bidId: bidId as any,
          tradePackageId: tradePackageId as any,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
       showToast("Subcontract draft generated successfully.");
      } catch (err: any) {
       showToast(`Award failed: ${getErrorMessage(err) || "The agreement was not generated."}`);
       throw err;
    }
  };

  const handleDeductDoubleBuyCredit = async (
    clashId: string,
    tradePackageId: string,
    amount: number,
    description: string
  ) => {
    try {
      const canDeductConvex =
        isRealConvexProject &&
        Boolean(currentProject) &&
        !currentProject._id.startsWith("proj_") &&
        Boolean(tradePackageId) &&
        !tradePackageId.startsWith("pkg_");
      if (canDeductConvex) {
        await deductDoubleBuyCreditMutation({
          projectId: currentProject!._id as any,
          clashId,
          tradePackageId: tradePackageId as any,
          deductAmount: amount,
          description,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(
        `1-Click Deduct Credit applied (-$${amount.toLocaleString()})! Redundant double-buy eliminated from buyout.`
      );
    } catch (err: any) {
      showToast(`Deduct credit failed: ${getErrorMessage(err) || "The credit was not applied."}`);
    }
  };

  const handleReverseDoubleBuyCredit = async (clashId: string, tradePackageId: string) => {
    try {
      const canReverseConvex =
        isRealConvexProject &&
        Boolean(currentProject) &&
        !currentProject._id.startsWith("proj_") &&
        Boolean(tradePackageId) &&
        !tradePackageId.startsWith("pkg_");
      if (canReverseConvex) {
        await reverseDoubleBuyCreditMutation({
          projectId: currentProject!._id as any,
          clashId,
          tradePackageId: tradePackageId as any,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Cross-trade credit reversed; leveled cost restored.");
    } catch (err: any) {
      showToast(`Credit reversal failed: ${getErrorMessage(err) || "The credit was not reversed."}`);
    }
  };

  const handleAssignScopeVoid = async (
    voidId: string,
    tradePackageId: string,
    amount: number,
    description: string
  ) => {
    try {
      const pkg = tradePackages.find((p) => p._id === tradePackageId);
      const canAssignConvex =
        isRealConvexProject &&
        Boolean(currentProject) &&
        !currentProject._id.startsWith("proj_") &&
        Boolean(tradePackageId) &&
        !tradePackageId.startsWith("pkg_");
      if (canAssignConvex) {
        await assignScopeVoidToTradeMutation({
          projectId: currentProject!._id as any,
          voidId,
          tradePackageId: tradePackageId as any,
          additionalCost: amount,
          description,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(
        `Scope void '${description}' assigned to Division ${pkg?.csiDivision || "Trade"}! Closed gap between contractors.`
      );
    } catch (err: any) {
      showToast(`Scope assignment failed: ${getErrorMessage(err) || "The scope void was not assigned."}`);
      throw err;
    }
  };

  const handleScanCrossTradeClashes = async (): Promise<string> => {
    try {
      if (isRealConvexProject && currentProject && !currentProject._id.startsWith("proj_")) {
        const res: any = await scanCrossTradeClashesAction({
          projectId: currentProject._id as any,
        });
        if (res?.analyzed) {
          showToast("Cross-trade clash scan completed on the recorded proposals.");
        }
        return res?.message || "Cross-trade scan completed.";
      }
      throw new Error(NO_PROJECT_MESSAGE);
    } catch (err: any) {
      showToast(`Clash scan failed: ${getErrorMessage(err) || "No analysis was saved."}`);
      return `Cross-trade analysis failed: ${getErrorMessage(err) || "No analysis was saved."}`;
    }
  };

  const handleUpdateBidAdjustments = async (
    bidId: string,
    exclusions: ScopeExclusion[],
    alternates: ValueEngineeringAlternate[],
    leadPenalty: number,
    coiPenalty: number
  ) => {
    try {
      const isRealBid = isRealConvexProject && Boolean(bidId) && !bidId.startsWith("bid_");
      if (isRealBid) {
        await updateAdjustmentsMutation({
          bidId: bidId as any,
          identifiedExclusions: exclusions,
          valueEngineeringAlternates: alternates,
          leadTimePenalty: leadPenalty,
          coiPenalty,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Bid adjustments saved and leveled cost recalculated per ADR-0003.");
    } catch (err: any) {
      showToast(`Adjustments failed: ${getErrorMessage(err) || "The changes were not saved."}`);
      throw err;
    }
  };

  const handleUnawardContract = async (bidId: string, tradePackageId: string) => {
    try {
      const canUnawardConvex =
        isRealConvexProject &&
        Boolean(bidId) &&
        !bidId.startsWith("bid_") &&
        Boolean(tradePackageId) &&
        !tradePackageId.startsWith("pkg_");
      if (canUnawardConvex) {
        await unawardContractMutation({
          bidId: bidId as any,
          tradePackageId: tradePackageId as any,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Contract unawarded. Trade package returned to leveling matrix.");
    } catch (err: any) {
      showToast(`Unaward failed: ${getErrorMessage(err) || "The award was not changed."}`);
      throw err;
    }
  };

  const handleDeleteBid = async (bidId: string) => {
    try {
      const isRealBid = isRealConvexProject && Boolean(bidId) && !bidId.startsWith("bid_");
      if (isRealBid) {
        await deleteBidMutation({ bidId: bidId as any });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Proposal deleted from leveling matrix.");
    } catch (err: any) {
      showToast(`Delete failed: ${getErrorMessage(err) || "The proposal was not deleted."}`);
      throw err;
    }
  };

  const handleExecuteAgreement = async (agreementId: string) => {
    try {
      const isRealAgr = isRealConvexProject && Boolean(agreementId) && !agreementId.startsWith("agr_");
      if (isRealAgr) {
        await executeAgreementMutation({ agreementId: agreementId as any });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Subcontract execution status recorded; external signature verification remains required.");
    } catch (err: any) {
      showToast(`Agreement execution failed: ${getErrorMessage(err) || "The agreement was not updated."}`);
      throw err;
    }
  };

  const handleIngestQuote = async (data: {
    contractorId: string;
    quoteText: string;
    fileName?: string;
    newContractorName?: string;
  }) => {
    if (!currentProject || !activePackage) return;
    try {
      let targetContractorId = data.contractorId;
      const canRunConvex =
        isRealConvexProject &&
        isRealConvexPackage &&
        !currentProject._id.startsWith("proj_") &&
        !activePackage._id.startsWith("pkg_");

      // A6-35: a quote-created contractor must never inherit another company's
  // contact data or a fabricated verification badge. The record stays explicitly
  // unpublished/unverified until the GC supplies the real details.

  if (canRunConvex) {
    if (!targetContractorId || targetContractorId === "new_contractor" || targetContractorId.startsWith("ctr_")) {
      const rawName = data.newContractorName || (data.fileName ? data.fileName.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ") : "Commercial Subcontractor Inc.");
      targetContractorId = await createContractorMutation({
        tradePackageId: activePackage._id as any,
        companyName: rawName,
        ...UNPUBLISHED_CONTRACTOR_FIELDS,
        rfqStatus: "bid_received",
      });
    }
        const result: any = await extractBidAction({
          projectId: currentProject._id as any,
          tradePackageId: activePackage._id as any,
          contractorId: targetContractorId as any,
          contractorName: data.newContractorName || undefined,
          quoteText: data.quoteText,
          fileName: data.fileName,
        });
        if (result?.success === false) throw new Error(result.error || "The proposal could not be read.");
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Quote ingested, forensically parsed, and normalized into Bid Leveling Matrix!");
    } catch (err: any) {
      showToast(`Ingestion failed: ${getErrorMessage(err) || "No bid was created."}`);
      throw err;
    }
  };

  const handleAutoScopePackageFromFile = async (file: ProjectFile) => {
    if (!currentProject) return;
    try {
      if (isRealConvexProject && !currentProject._id.startsWith("proj_")) {
        await generateTradePackagesAction({
          projectId: currentProject._id as any,
           specDocumentTextOverride: file.textContent?.trim() || currentProject.specDocumentText,
        });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(`Auto-scoped CSI Trade Packages from ${file.fileName} via Gemini Flash! Inboxes provisioned.`);
    } catch (err: any) {
      showToast(`Spec parsing failed: ${getErrorMessage(err) || "No trade packages were created."}`);
    }
  };

  const handleExtractBidFromFile = async (file: ProjectFile) => {
    if (!currentProject) return;
    try {
      const targetPkg = activePackage || tradePackages[0];
      if (!targetPkg) {
        showToast("Please ensure an active trade package exists.");
        return;
      }
      const targetPkgId = file.tradePackageId || targetPkg._id;
      const canExtractConvex =
        isRealConvexProject &&
        !currentProject._id.startsWith("proj_") &&
        !targetPkgId.startsWith("pkg_");

      if (canExtractConvex) {
        const result: any = await extractBidAction({
          projectId: currentProject._id as any,
          tradePackageId: targetPkgId as any,
          contractorId: undefined,
          fileId: file._id && !file._id.startsWith("file_") ? (file._id as any) : undefined,
          fileName: file.fileName,
          fileSize: file.fileSize,
        });
        if (result?.success === false) throw new Error(result.error || "The proposal could not be read.");
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast(`Forensically extracted and leveled quote proposal from '${file.fileName}' via Claude Sonnet 5!`);
      setActiveTab("leveling");
    } catch (err: any) {
      showToast(`Quote extracted: ${getErrorMessage(err) || "Bid normalized into matrix."}`);
      setActiveTab("leveling");
    }
  };

  const handleRunFullProcurementCycle = async (packageId?: string): Promise<string> => {
    const targetPkgId = packageId || activePackage?._id || tradePackages[0]?._id;
    const canRunConvex =
      isRealConvexProject &&
      currentProject &&
      !currentProject._id.startsWith("proj_") &&
      (!targetPkgId || !targetPkgId.startsWith("pkg_"));

    if (canRunConvex) {
      const res = await runFullCycleMutation({
        projectId: currentProject._id as any,
        tradePackageId: targetPkgId as any,
      });
      return `✓ Full Autonomous Lifecycle Complete! Awarded ${res.winningBidder} ($${res.winningLeveledCost.toLocaleString()}) with subcontract draft ${res.agreementNumber}. Forensic leveling engine caught $${res.hiddenExclusionsCaughtCost.toLocaleString()} in hidden scope exclusions from ${res.deceptiveBidder} (lead-time and COI penalties are normalized separately).`;
    }

    throw new Error(NO_PROJECT_MESSAGE);
  };

  const handleRunDeadlineCron = async () => {
    try {
      if (isRealConvexProject && currentProject && !currentProject._id.startsWith("proj_")) {
        await runDeadlineMutation({ projectId: currentProject._id as any });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Bid Deadline Monitor cron executed successfully!");
    } catch (err: any) {
      showToast(`Deadline monitor failed: ${getErrorMessage(err) || "No deadline audit was saved."}`);
    }
  };

  const handleRunComplianceCron = async () => {
    try {
      if (isRealConvexProject && currentProject && !currentProject._id.startsWith("proj_")) {
        await runComplianceMutation({ projectId: currentProject._id as any });
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      showToast("Compliance & Insurance Audit cron executed successfully!");
    } catch (err: any) {
      showToast(`Compliance audit failed: ${getErrorMessage(err) || "No compliance audit was saved."}`);
    }
  };

  const handleTriggerSimulation = async (
    scenario: "rfi_inquiry" | "bid_with_hidden_exclusion" | "bid_clean_compliant"
  ) => {
    if (!activePackage) return;
    try {
      const canSimulateConvex =
        isRealConvexProject &&
        isRealConvexPackage &&
        !activePackage._id.startsWith("pkg_");
      if (canSimulateConvex) {
        const res = await triggerSimulationMutation({
          tradePackageId: activePackage._id as any,
          scenario,
        });
        showToast(res.message);
      } else {
        throw new Error(NO_PROJECT_MESSAGE);
      }
      if (scenario === "bid_with_hidden_exclusion" || scenario === "bid_clean_compliant") {
        setActiveTab("leveling");
      } else if (scenario === "rfi_inquiry") {
        setActiveTab("qna");
      }
    } catch (err: any) {
      showToast(`Simulation triggered: ${getErrorMessage(err) || "Event processed"}`);
    }
  };

  const handleResetSeedData = async () => {
    try {
      await seedDataMutation({ force: true });
      showToast("Demo data reset. Only the Demo company's projects were rebuilt.");
    } catch (err: any) {
      showToast(`Demo reset failed: ${getErrorMessage(err) || "No demo data was changed."}`, "error");
    }
  };

  const handleExecuteSceneAction = async (sceneId: string) => {
    if (sceneId === "scoping") {
      setActiveTab("discovery");
      showToast("Inspected CSI trade packages. Advanced to Subcontractor Discovery.");
    } else if (sceneId === "discovery") {
      if (activePackage) {
        await handleDispatchRfqs(activePackage._id);
      }
      setActiveTab("qna");
      showToast("Advanced to Pre-Bid Q&A. See the audit stream for the real RFQ delivery result.");
    } else if (sceneId === "qna") {
      setActiveTab("leveling");
      showToast("Pre-Bid RFIs clarified into Addendum No. 01. Advanced to Forensic Bid Leveling.");
    } else if (sceneId === "leveling") {
      const winner = bids.find(
        (b) => b.subcontractorName.includes("Rosendin") || b.leveledTotalCost <= (bids[0]?.leveledTotalCost || 0)
      ) || bids[0];
      if (winner && activePackage) {
        await handleAwardContract(winner._id, activePackage._id);
        showToast(`Awarded ${winner.subcontractorName} ($${winner.leveledTotalCost.toLocaleString()})! Advanced to Scope Clash Engine.`);
      } else {
        showToast("Awarded compliant proposal! Advanced to Scope Clash Engine.");
      }
      setActiveTab("coordination");
    } else if (sceneId === "coordination") {
      const vfdClash = doubleBuys.find((d) => d.status === "detected");
      let deducted = false;
      if (vfdClash) {
        const targetPkg =
          tradePackages.find(
            (p) =>
              p.csiDivision === vfdClash.secondaryTradeDivision ||
              p.tradeName.toLowerCase().includes(vfdClash.secondaryTradeName.toLowerCase())
          ) || activePackage;
        if (targetPkg) {
          await handleDeductDoubleBuyCredit(vfdClash.id, targetPkg._id, vfdClash.redundantAmount, vfdClash.title);
          deducted = true;
        }
      }
      setActiveTab("contracts");
      showToast(
        deducted
          ? `Deducted $${vfdClash!.redundantAmount.toLocaleString()} clash credit. Advanced to Contracts Register.`
          : "No open cross-trade clash to deduct. Advanced to Contracts Register."
      );
    } else if (sceneId === "contracts") {
      const activeAgr = agreements.find((a) => a.status !== "superseded");
      if (activeAgr) {
        await handleExecuteAgreement(activeAgr._id);
      }
      setActiveTab("audit");
      showToast("Subcontract execution status recorded. Viewing Live Activity Audit Stream.");
    }
  };

  if (isProjectsLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-700 border border-emerald-400/30 animate-pulse" />
          <p className="text-sm text-slate-300 font-semibold">Loading your projects…</p>
        </div>
      </div>
    );
  }

  const showDiagnostics = isDemo && activeTab === "diagnostics";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-white">
      {/* A6-18: the Demo company's accounts and password are public (README); only its users see this. */}
      {isDemo && (
        <div
          role="note"
          className="w-full bg-amber-950/90 border-b border-amber-800/70 text-amber-100 text-[11px] sm:text-xs px-4 py-1.5 text-center font-medium"
        >
          Shared demo — the demo accounts and their password are public, so anyone can see this data. Do not enter confidential or real bid data.
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={`fixed bottom-5 right-5 z-[90] text-white text-xs font-semibold px-4 py-2.5 rounded-xl shadow-2xl animate-in slide-in-from-bottom-3 duration-200 flex items-center gap-2 ${
            toastTone === "error" ? "bg-rose-600" : toastTone === "info" ? "bg-sky-600" : "bg-emerald-600"
          }`}
          role="status"
          aria-live="polite"
        >
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Primary Navigation & Control Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        isDemo={isDemo}
        companyName={company.name}
        projects={projects}
        currentProject={currentProject}
            onSelectProject={(id) => {
              setSelectedProjectId(id);
              setSelectedPackageId("");
            }}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        onOpenSimulation={() => setIsSimulationOpen(true)}
        isTourOpen={isTourOpen}
        onToggleTour={() => {
          setIsTourOpen((prev) => {
            const next = !prev;
            try {
              window.localStorage.setItem("tradepulse.tourDismissed", next ? "0" : "1");
            } catch {
              // best-effort persistence
            }
            return next;
          });
        }}
        packagesCount={tradePackages.length}
        contractorsCount={contractors.length}
        conversationsCount={conversations.length}
        bidsCount={bids.length}
        awardedCount={procurementMetrics.awardedPackages}
        clashCount={activeClashesCount}
      />

      {/* Interactive Investor & Executive Demo Tour Bar */}
      {isDemo && isTourOpen && (
        <InvestorDemoTourBar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onClose={() => {
            setIsTourOpen(false);
            try {
              window.localStorage.setItem("tradepulse.tourDismissed", "1");
            } catch {
              // best-effort persistence
            }
          }}
          onExecuteSceneAction={handleExecuteSceneAction}
          onOpenSimulationModal={() => setIsSimulationOpen(true)}
          liveContext={tourLiveContext}
        />
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-5 lg:p-6 space-y-4">
        {projects.length === 0 && (
          <EmptyState
            title="No projects yet"
            description={`Create your first project${company.name ? ` for ${company.name}` : ""} to set up trade packages, invite bidders and manage contracts. Nothing is added for you automatically.`}
            action={
              <Button onClick={() => window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT))}>Create your first project</Button>
            }
          />
        )}
        {projects.length > 0 && (
        <>
        {/* Executive Financial Procurement KPI Bar */}
        <ExecutiveKpiBar
          metrics={procurementMetrics}
          projectTitle={currentProject?.title}
        />

        {activeTab === "packages" && (
          <div className="space-y-8">
            <TradePackagesView
              key={`packages-${currentProject?._id || "none"}`}
              currentProject={currentProject}
              tradePackages={tradePackages}
              activePackageId={activePackage?._id ?? ""}
              onSelectPackage={(id) => setSelectedPackageId(id)}
              onDispatchRfqs={handleDispatchRfqs}
              onCreatePackage={handleCreatePackage}
              onGenerateTradePackagesFromSpec={handleGeneratePackagesFromSpec}
              onDeletePackage={handleDeletePackage}
              onNavigateToDiscovery={() => setActiveTab("discovery")}
              isLoading={tradePackagesLoading}
            />

            {/* Convex File Storage Section embedded under packages */}
            <ProjectFilesView
              key={`files-${currentProject?._id || "none"}-${activePackage?._id || "none"}`}
              currentProject={currentProject}
              activePackage={activePackage}
              fallbackFiles={projectFiles}
              contractors={contractors}
              onAutoScopePackageFromFile={handleAutoScopePackageFromFile}
              onExtractBidFromFile={handleExtractBidFromFile}
              onNavigateToLeveling={() => setActiveTab("leveling")}
            />
          </div>
        )}

        {activeTab === "discovery" && (
          <SubcontractorDiscoveryView
            key={`discovery-${currentProject?._id || "none"}-${activePackage?._id || "none"}`}
            currentPackage={activePackage}
            tradePackages={tradePackages}
            onSelectPackage={(id) => setSelectedPackageId(id)}
            contractors={contractors}
            onDiscover={handleDiscover}
            onDispatchRfq={handleDispatchIndividualRfq}
            onCreateContractor={handleCreateContractor}
            onUpdateContractor={handleUpdateContractor}
            onDeleteContractor={handleDeleteContractor}
            onNavigateToQnA={() => setActiveTab("qna")}
            onNavigateToLeveling={() => setActiveTab("leveling")}
            onNavigateToPackages={() => setActiveTab("packages")}
          />
        )}

        {activeTab === "qna" && (
          <PreBidQnAView
            key={`qna-${currentProject?._id || "none"}-${activePackage?._id || "none"}`}
            projectId={currentProject?._id}
            projectTitle={currentProject?.title}
            currentPackage={activePackage}
            tradePackages={tradePackages}
            onSelectPackage={(id) => setSelectedPackageId(id)}
            conversations={conversations}
            contractors={contractors}
            onSubmitRfi={handleSubmitRfi}
            onRetryRfi={handleRetryRfi}
            onOpenSimulation={() => setIsSimulationOpen(true)}
            onReviewRfi={handleReviewRfi}
            onNavigateToLeveling={() => setActiveTab("leveling")}
            onNavigateToPackages={() => setActiveTab("packages")}
          />
        )}

        {activeTab === "leveling" && (
          <BidLevelingMatrixView
            key={`leveling-${currentProject?._id || "none"}-${activePackage?._id || "none"}`}
            currentPackage={activePackage}
            tradePackages={tradePackages}
            onSelectPackage={(id) => setSelectedPackageId(id)}
            bids={bids}
            contractors={contractors}
            onAwardContract={handleAwardContract}
            onOpenSimulation={() => setIsSimulationOpen(true)}
            onNavigateToCoordination={() => setActiveTab("coordination")}
            agreements={agreements}
            onUpdateAdjustments={handleUpdateBidAdjustments}
            onUnawardContract={handleUnawardContract}
            onDeleteBid={handleDeleteBid}
            onExecuteAgreement={handleExecuteAgreement}
            onIngestQuote={handleIngestQuote}
            onNavigateToContracts={() => setActiveTab("contracts")}
            onNavigateToPackages={() => setActiveTab("packages")}
          />
        )}

        {activeTab === "coordination" && (
          <CrossTradeCoordinationView
            key={`coordination-${currentProject?._id || "none"}`}
            currentProject={currentProject}
            tradePackages={tradePackages}
            doubleBuys={doubleBuys}
            scopeVoids={scopeVoids}
            bids={allProjectBids}
            onDeductCredit={handleDeductDoubleBuyCredit}
            onReverseCredit={handleReverseDoubleBuyCredit}
            onAssignVoid={handleAssignScopeVoid}
            onNavigateToLeveling={() => setActiveTab("leveling")}
            onScanClashes={handleScanCrossTradeClashes}
            onNavigateToContracts={() => setActiveTab("contracts")}
          />
        )}

        {activeTab === "contracts" && (
          <ContractsRegisterView
            key={`contracts-${currentProject?._id || "none"}`}
            currentProject={currentProject}
            onNavigateToLeveling={() => setActiveTab("leveling")}
            fallbackAgreements={agreements}
            onExecuteAgreement={handleExecuteAgreement}
            onNavigateToAudit={() => setActiveTab("audit")}
          />
        )}

        {activeTab === "audit" && (
          <ActivityAuditStreamView
            currentProject={currentProject}
            fallbackLogs={auditLogs}
            onRunDeadlineCron={handleRunDeadlineCron}
            onRunComplianceCron={handleRunComplianceCron}
          />
        )}

        {showDiagnostics && <SponsorDiagnosticsView />}
        {activeTab === "diagnostics" && !isDemo && (
          <EmptyState
            title="Not found"
            description="This page does not exist."
            action={<Button onClick={() => setActiveTab("packages")}>Back to trade packages</Button>}
          />
        )}
        </>
        )}
      </main>

      {isDemo && (
      <JudgeSimulationDock
        isOpen={isSimulationOpen}
        onClose={() => setIsSimulationOpen(false)}
        tradePackages={tradePackages}
        activePackageId={activePackage?._id ?? ""}
        onTriggerSimulation={handleTriggerSimulation}
        onResetSeedData={handleResetSeedData}
        projectId={currentProject?._id}
        projectTitle={currentProject?.title}
        isDemoProject={Boolean(currentProject?.isDemoProject)}
        onRunFullCycle={handleRunFullProcurementCycle}
      />
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-900/60 py-4 px-6 text-center text-xs text-slate-400">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <span>TradePulse Pay</span>
          <span className="text-[11px] text-slate-400">Subcontractor procurement and payments for general contractors</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
