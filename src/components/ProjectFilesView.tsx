import { getErrorMessage } from "../lib/errors.ts";
import React, { useState, useRef, useEffect } from "react";
import {
  FileText,
  Upload,
  Download,
  Trash2,
  FileCheck,
  RefreshCw,
  FolderOpen,
  Sparkles,
  Scale,
  ArrowRight,
  Eye,
  X,
  ExternalLink,
} from "lucide-react";
import { useQuery, useMutation, useAction } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api.js";
import {
  REAL_DOCUMENTS,
} from "../../convex/realDocuments.ts";
import { extractTextFromPdfStream } from "../lib/documentText.ts";
import { Project, TradePackage, ProjectFile, Contractor } from "../types.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { useDialogFocus } from "../lib/useDialogFocus.ts";
import { formatDateOnly } from "../lib/datetime.ts";
import {
  fetchAuthenticatedFile,
  isServedArchiveRecord,
  resolveStoredFileText,
  resolveStoredFileUrl,
} from "../lib/storedFile.ts";

const CONVEX_ENV = {
  VITE_CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL as string | undefined,
  VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL as string | undefined,
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_UPLOAD_EXTENSIONS = [".pdf", ".dwg", ".dxf", ".txt"];

const ALLOWED_EXTENSIONS_BY_TYPE: Record<string, string[]> = {
  blueprint: [".pdf", ".dwg", ".dxf", ".txt"],
  spec: [".pdf", ".txt"],
  quote_pdf: [".pdf", ".txt"],
  coi_certificate: [".pdf"],
  addendum: [".pdf", ".txt"],
};

const FILE_TYPE_LABELS: Record<string, string> = {
  blueprint: "MEP blueprint drawing",
  spec: "CSI specification",
  quote_pdf: "Subcontractor quote",
  coi_certificate: "ACORD 25 COI certificate",
  addendum: "Project addendum",
};

interface ProjectFilesViewProps {
  currentProject: Project | null;
  activePackage: TradePackage | null;
  fallbackFiles?: ProjectFile[];
  contractors?: Contractor[];
  onAutoScopePackageFromFile?: (file: ProjectFile) => Promise<void>;
  onExtractBidFromFile?: (file: ProjectFile) => Promise<void>;
  onNavigateToLeveling?: () => void;
  onFileDeleted?: (fileId: string) => void;
  onFileUploaded?: (file: ProjectFile) => void;
}

export const ProjectFilesView: React.FC<ProjectFilesViewProps> = ({
  currentProject,
  activePackage,
  fallbackFiles = [],
  contractors: _contractors = [],
  onAutoScopePackageFromFile,
  onExtractBidFromFile,
  onNavigateToLeveling,
  onFileDeleted,
  onFileUploaded,
}) => {
  const [uploading, setUploading] = useState(false);
  const [fileType, setFileType] = useState<string>("blueprint");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const authToken = useAuthToken();
  const [processingFileId, setProcessingFileId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<ProjectFile | null>(null);
  const [fileToDelete, setFileToDelete] = useState<ProjectFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewDialogRef = useDialogFocus<HTMLDivElement>(Boolean(previewFile));

  const allowedAcceptForType = (type: string) =>
    (ALLOWED_EXTENSIONS_BY_TYPE[type] || SUPPORTED_UPLOAD_EXTENSIONS).join(",");

  useEffect(() => {
    if (!previewFile) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewFile(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewFile]);

  const generateUploadUrlMutation = useMutation(api.files.generateUploadUrl);
  const saveFileRecordMutation = useMutation(api.files.saveFileRecord);
  const deleteFileMutation = useMutation(api.files.deleteFile);
  const generateTradePackagesAction = useAction(api.tradePackages.generateTradePackagesFromSpec);
  const extractBidAction = useAction(api.files.extractBidFromQuoteFile);

  const filesData = useQuery(
    api.files.listFilesByProject,
    currentProject && !currentProject._id.startsWith("proj_") ? { projectId: currentProject._id as any } : "skip"
  );
  const files: ProjectFile[] = (filesData as any) ?? (fallbackFiles.length > 0 ? fallbackFiles : []);

  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const detectFileType = (fileName: string): string => {
    const lower = fileName.toLowerCase();
    if (lower.includes("spec") || lower.includes("division") || lower.includes("section") || lower.includes("project_manual")) {
      return "spec";
    }
    if (lower.includes("quote") || lower.includes("bid") || lower.includes("proposal") || lower.includes("estimate") || lower.includes("pricing")) {
      return "quote_pdf";
    }
    if (lower.includes("acord") || lower.includes("coi") || lower.includes("certificate") || lower.includes("insurance") || lower.includes("endorsement")) {
      return "coi_certificate";
    }
    if (lower.includes("addendum") || lower.includes("bulletin") || lower.includes("rfi_response")) {
      return "addendum";
    }
    if (
      lower.endsWith(".dwg") ||
      lower.endsWith(".dxf") ||
      lower.includes("drawing") ||
      lower.includes("plan") ||
      lower.includes("mep") ||
      lower.includes("blueprint")
    ) {
      return "blueprint";
    }
    return fileType;
  };

  const uploadSingleFile = async (file: File, targetType?: string) => {
    if (!currentProject) return;
    const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    if (!extension || !SUPPORTED_UPLOAD_EXTENSIONS.includes(extension)) {
      throw new Error(`${file.name}: upload PDF, DWG, DXF, or TXT files only.`);
    }
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`${file.name}: file size must be greater than zero and no more than 50 MB.`);
    }
    const effectiveType = targetType || detectFileType(file.name);
    const allowedExtensionsByType: Record<string, string[]> = {
      blueprint: [".pdf", ".dwg", ".dxf"],
      spec: [".pdf", ".txt"],
      quote_pdf: [".pdf", ".txt"],
      coi_certificate: [".pdf"],
      addendum: [".pdf", ".txt"],
    };
    if (allowedExtensionsByType[effectiveType] && !allowedExtensionsByType[effectiveType].includes(extension)) {
      throw new Error(`${file.name}: ${effectiveType.replace(/_/g, " ")} files must use ${allowedExtensionsByType[effectiveType].join(", ")}.`);
    }
    let textContent: string | undefined;
    if (file.size < 10 * 1024 * 1024) {
      try {
        if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
          const arrBuf = await file.arrayBuffer();
          const uint8 = new Uint8Array(arrBuf);
          const decompressed = extractTextFromPdfStream(uint8);
          if (decompressed && decompressed.trim().length > 0) {
            textContent = decompressed;
          }
        } else {
          textContent = await file.text();
        }
      } catch {
        // Ignore binary decode errors
      }
    }
    let storageId: string;
    let uploadIntentId: string | undefined;
    if (currentProject._id.startsWith("proj_")) {
      storageId = `local_storage_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    } else {
      const upload = await generateUploadUrlMutation({ projectId: currentProject._id as any });
      uploadIntentId = upload.uploadIntentId;
      const result = await fetch(upload.uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!result.ok) {
        throw new Error(`Storage upload failed with HTTP ${result.status}.`);
      }
      const res = await result.json();
      if (!res.storageId) throw new Error("Storage upload did not return a file identifier.");
      storageId = res.storageId;
    }

    if (!currentProject._id.startsWith("proj_") && uploadIntentId) {
      await saveFileRecordMutation({
        projectId: currentProject._id as any,
        uploadIntentId: uploadIntentId as any,
        tradePackageId:
          activePackage && !activePackage._id.startsWith("pkg_") ? (activePackage._id as any) : undefined,
        storageId,
        fileName: file.name,
        fileType: effectiveType,
        fileSize: file.size,
        contentType: file.type || undefined,
        textContent,
        uploadedBy: "Chief Estimator / Project PM",
      });
    }

    if (onFileUploaded) {
      onFileUploaded({
        _id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        projectId: currentProject._id,
        tradePackageId: activePackage?._id,
        storageId,
        fileName: file.name,
        fileType: effectiveType,
        fileSize: file.size,
        textContent,
        uploadedBy: "Chief Estimator / Project PM",
        uploadedAt: Date.now(),
      });
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0 || !currentProject) return;

    setUploading(true);
    setStatusMsg(`Uploading ${fileList.length} file(s) to Convex File Storage...`);

    try {
      for (let i = 0; i < fileList.length; i++) {
        await uploadSingleFile(fileList[i], fileType);
      }
      setStatusMsg(`Successfully uploaded ${fileList.length} file(s) to Convex Storage!`);
      setTimeout(() => setStatusMsg(null), 4000);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err: any) {
      setStatusMsg(`Upload failed: ${getErrorMessage(err) || "The file was not saved."}`);
      setTimeout(() => setStatusMsg(null), 4000);
    } finally {
      setUploading(false);
    }
  };

  const handleDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (!currentProject) return;

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    setUploading(true);
    setStatusMsg(`Auto-classifying and uploading ${droppedFiles.length} dropped file(s)...`);
    try {
      for (const file of droppedFiles) {
        const detected = detectFileType(file.name);
        setStatusMsg(`Uploading ${file.name} (classified as: ${detected})...`);
        await uploadSingleFile(file, detected);
      }
      setStatusMsg(`Successfully uploaded ${droppedFiles.length} file(s) to Convex Storage!`);
      setTimeout(() => setStatusMsg(null), 4500);
    } catch (err: any) {
      setStatusMsg(`Drop upload failed: ${getErrorMessage(err) || "The files were not saved."}`);
      setTimeout(() => setStatusMsg(null), 4500);
    } finally {
      setUploading(false);
    }
  };

  const triggerBlobDownload = (blob: Blob, fileName: string) => {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
  };

  const handleDownloadFile = async (file: ProjectFile) => {
    // 0. Uploaded bytes come only through the authenticated download route.
    if (file.downloadPath) {
      try {
        const blob = await fetchAuthenticatedFile(file, authToken, CONVEX_ENV);
        if (blob) triggerBlobDownload(blob, file.fileName);
      } catch (err) {
        setStatusMsg(`Download failed for ${file.fileName}: ${getErrorMessage(err)}`);
        setTimeout(() => setStatusMsg(null), 5000);
      }
      return;
    }

    // 1. Serve the stored object verbatim: fetch the Convex storage URL / app document
    // router path as bytes and save it under the record's own filename.
    const storedUrl = resolveStoredFileUrl(file);
    if (storedUrl) {
      try {
        const response = await fetch(storedUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        triggerBlobDownload(blob, file.fileName);
        return;
      } catch {
        // Fall back to opening the stored URL directly if the fetch is blocked.
        window.open(storedUrl, "_blank");
        return;
      }
    }

    // 2. Text-readable records serve their stored text content verbatim.
    const storedText = resolveStoredFileText(file);
    if (storedText) {
      triggerBlobDownload(new Blob([storedText], { type: "text/plain;charset=utf-8;" }), file.fileName);
      return;
    }

    // 3. Nothing is stored for this record: say so instead of synthesising a document.
    setStatusMsg(`Download unavailable: no stored bytes were found for ${file.fileName}.`);
    setTimeout(() => setStatusMsg(null), 5000);
  };

  const handleDeleteFile = (file: ProjectFile) => {
    setFileToDelete(file);
  };

  const confirmDeleteFile = async () => {
    if (!fileToDelete) return;
    // A11-02: rethrow so ConfirmDialog shows the guard reason inline (the
    // overlay otherwise hides the page-level status banner).
    if (!fileToDelete._id.startsWith("file_")) {
      await deleteFileMutation({ fileId: fileToDelete._id as any });
    }
    if (onFileDeleted) {
      onFileDeleted(fileToDelete._id);
    }
    setFileToDelete(null);
    setStatusMsg("File deleted from storage.");
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const handleAutoScope = async (file: ProjectFile) => {
    if (!currentProject) return;
    setProcessingFileId(file._id);
    setStatusMsg(`Auto-scoping CSI Trade Packages from '${file.fileName}' via Gemini Flash...`);
    try {
      if (onAutoScopePackageFromFile) {
        await onAutoScopePackageFromFile(file);
      } else {
        await generateTradePackagesAction({
          projectId: currentProject._id as any,
           specDocumentTextOverride: file.textContent?.trim() || currentProject.specDocumentText,
        });
      }
      setStatusMsg(`Successfully auto-scoped trade packages from ${file.fileName}! Inboxes provisioned.`);
      setTimeout(() => setStatusMsg(null), 4500);
    } catch (err: any) {
      setStatusMsg(`Auto-scoping failed: ${getErrorMessage(err) || "No packages were generated."}`);
      setTimeout(() => setStatusMsg(null), 4500);
    } finally {
      setProcessingFileId(null);
    }
  };

  const handleExtractBid = async (file: ProjectFile) => {
    if (!currentProject) return;
    setProcessingFileId(file._id);
    setStatusMsg(`Extracting quote proposal & forensic exclusions from '${file.fileName}' via Claude Sonnet 5...`);
    try {
      if (onExtractBidFromFile) {
        await onExtractBidFromFile(file);
      } else {
        const targetPkg = activePackage;
        if (!targetPkg) {
          throw new Error("Please select an active trade package before extracting proposals.");
        }
        const result = await extractBidAction({
          projectId: currentProject._id as any,
          tradePackageId: (file.tradePackageId || targetPkg._id) as any,
          contractorId: undefined,
          fileId: file._id && !file._id.startsWith("file_") ? (file._id as any) : undefined,
          fileName: file.fileName,
          fileSize: file.fileSize,
        });
        if (result && result.success === false) throw new Error(result.error || "The proposal could not be read.");
      }
      setStatusMsg(`Bid extracted and normalized into Bid Leveling Matrix from '${file.fileName}'!`);
      setTimeout(() => setStatusMsg(null), 4500);
    } catch (err: any) {
      setStatusMsg(`Bid extraction failed: ${getErrorMessage(err) || "No bid was created."}`);
      setTimeout(() => setStatusMsg(null), 4500);
    } finally {
      setProcessingFileId(null);
    }
  };

  const getFileTypeBadge = (type: string) => {
    switch (type) {
      case "blueprint":
        return "bg-blue-950/80 text-blue-300 border-blue-800/60";
      case "spec":
        return "bg-emerald-950/80 text-emerald-300 border-emerald-800/60";
      case "quote_pdf":
        return "bg-amber-950/80 text-amber-300 border-amber-800/60";
      case "coi_certificate":
        return "bg-purple-950/80 text-purple-300 border-purple-800/60";
      default:
        return "bg-slate-800 text-slate-300 border-slate-700";
    }
  };

  return (
    <div className="space-y-6">
      {/* View Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-bold text-white tracking-tight">
              Convex File Storage (_storage): Drawings, Specs & Quotes
            </h2>
          </div>
          <p className="text-xs text-slate-400">
            Store and serve MEP blueprint drawings, CSI specification PDFs, subcontractor quotes, and ACORD 25 certificates with direct AI actions.
          </p>
        </div>

        {/* Upload Controls */}
        <div className="flex items-center gap-2">
          <select
            aria-label="Document type for upload"
            value={fileType}
            onChange={(e) => setFileType(e.target.value)}
            className="bg-slate-850 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500"
          >
            <option value="blueprint">MEP Blueprint Drawing</option>
            <option value="spec">CSI Specification PDF</option>
            <option value="quote_pdf">Subcontractor Quote PDF</option>
            <option value="coi_certificate">ACORD 25 COI Certificate</option>
            <option value="addendum">Project Addendum</option>
          </select>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            id="convex-file-upload"
            multiple
            accept={allowedAcceptForType(fileType)}
          />

          <label
            htmlFor="convex-file-upload"
            className="bg-emerald-700 hover:bg-emerald-700 text-white font-semibold text-xs px-3.5 py-2 rounded-lg flex items-center gap-1.5 transition cursor-pointer shadow-sm"
          >
            {uploading ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5" />
            )}
            {uploading ? "Uploading..." : "Upload to Convex Storage"}
          </label>
        </div>
      </div>

      {/* Upload Status Banner */}
      {statusMsg && (
        <div className="bg-slate-850 border border-emerald-500/50 rounded-xl p-3.5 text-xs text-emerald-300 flex items-center gap-2 animate-in fade-in">
          <FileCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{statusMsg}</span>
        </div>
      )}

      {/* Modern Drag & Drop Zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDraggingOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDraggingOver(false);
        }}
        onDrop={handleDropFiles}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all duration-200 ${
          isDraggingOver
            ? "border-emerald-400 bg-emerald-950/40 ring-4 ring-emerald-500/20 scale-[1.005]"
            : "border-slate-700/80 hover:border-slate-600 bg-slate-900/50 hover:bg-slate-900/80"
        }`}
      >
        <div className="flex flex-col items-center justify-center gap-2">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center transition ${
              isDraggingOver ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-800 text-slate-400"
            }`}
          >
            <Upload className={`w-6 h-6 ${isDraggingOver ? "text-emerald-400 animate-bounce" : ""}`} />
          </div>
          <div>
            <span className="text-xs font-bold text-white">
              {isDraggingOver ? "Drop files to upload instantly" : "Drag & Drop Drawings, Specs, Quotes, or ACORD COIs here"}
            </span>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Supports PDF, DWG, DXF, TXT • Document type is the one selected above (drag & drop infers it from the file name) • Stored in Convex _storage
            </p>
          </div>
        </div>
      </div>

      {/* Files List */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-200 flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-emerald-400" />
            Project Documents in Convex Storage ({files.length})
          </span>
          <span className="text-slate-400 font-mono text-[11px]">
            Convex _storage with direct File-to-AI Actions
          </span>
        </div>

        {files.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs">
            No files uploaded yet. Select a file type and click "Upload to Convex Storage" to store drawing PDFs or specs.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80">
            {files.map((file) => {
              const isSpec = file.fileType === "spec";
              const isQuote = file.fileType === "quote_pdf";
              const isProcessing = processingFileId === file._id;

              return (
                <div
                  key={file._id}
                  className="p-4 sm:px-6 flex flex-wrap items-center justify-between gap-4 hover:bg-slate-850/40 transition"
                >
                  <div className="flex items-center gap-3 min-w-[240px]">
                    <div className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300">
                      <FileText className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-white mb-0.5">{file.fileName}</h4>
                      <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                        <span>{(file.fileSize / 1024).toFixed(1)} KB</span>
                        <span>•</span>
                        <span>Uploaded {new Date(file.uploadedAt).toLocaleDateString()}</span>
                        <span>•</span>
                        <span className="text-slate-400">{file.uploadedBy}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span
                      className={`text-[10px] font-semibold border px-2 py-0.5 rounded-full uppercase tracking-wider font-mono ${getFileTypeBadge(
                        file.fileType
                      )}`}
                    >
                      {file.fileType.replace(/_/g, " ")}
                    </span>

                    {/* Direct File-to-AI Actions */}
                    {isSpec && (
                 <button
                        onClick={() => handleAutoScope(file)}
                        disabled={isProcessing}
                        className="bg-emerald-700/90 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition shadow-sm"
                        title="Parse CSI specification and generate trade packages with dynamic inboxes"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                        <span>{isProcessing ? "Scoping..." : "Auto-Scope Packages"}</span>
                      </button>
                    )}

                    {isQuote && (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleExtractBid(file)}
                          disabled={isProcessing}
                          className="bg-sky-700/90 hover:bg-sky-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition shadow-sm"
                          title="Forensically extract line items, fine-print exclusions, and level into matrix"
                        >
                          <Scale className="w-3.5 h-3.5" />
                          <span>{isProcessing ? "Extracting..." : "Extract & Level Bid"}</span>
                        </button>
                        {onNavigateToLeveling && (
                          <button
                            onClick={onNavigateToLeveling}
                            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition text-xs flex items-center gap-1"
                            title="Inspect in Bid Leveling Matrix"
                          >
                            <ArrowRight className="w-3.5 h-3.5 text-sky-400" />
                            <span className="hidden xl:inline text-[11px]">Leveling Matrix</span>
                          </button>
                        )}
                      </div>
                    )}

                    <button
                      onClick={() => setPreviewFile(file)}
                      className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition text-xs flex items-center gap-1"
                      title="Preview stored specification/document text"
                    >
                      <Eye className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="hidden sm:inline">Preview</span>
                    </button>

                    <button
                      onClick={() => handleDownloadFile(file)}
                      className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg transition text-xs flex items-center gap-1"
                      title={file.url ? "Download file from Convex Storage" : "Download document archive"}
                    >
                      <Download className="w-3.5 h-3.5 text-sky-400" />
                      <span className="hidden sm:inline">Download</span>
                    </button>

                    <button
                       onClick={() => handleDeleteFile(file)}
                      className="p-2 bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 border border-slate-700 hover:border-rose-800/60 rounded-lg transition"
                      title="Delete file from storage"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Document Preview Modal */}
      {previewFile && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewFile(null);
          }}
        >
          <div
            ref={previewDialogRef}
            className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview of ${previewFile.fileName}`}
          >
            <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between gap-3 bg-slate-950">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-950/80 border border-emerald-700/60 flex items-center justify-center text-emerald-400">
                  <FileText className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                    {previewFile.fileName}
                    <span
                      className={`text-[10px] font-semibold border px-2 py-0.5 rounded-full uppercase tracking-wider font-mono ${getFileTypeBadge(
                        previewFile.fileType
                      )}`}
                    >
                      {previewFile.fileType.replace(/_/g, " ")}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    Uploaded by: {previewFile.uploadedBy} • {(previewFile.fileSize / 1024).toFixed(1)} KB
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDownloadFile(previewFile)}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-xs font-semibold transition flex items-center gap-1.5 shadow-sm"
                  title={previewFile.url || previewFile.downloadPath || previewFile.textContent ? "Download stored file" : "No stored bytes available"}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{previewFile.url || previewFile.downloadPath || previewFile.textContent ? "Download stored file" : "Download unavailable"}</span>
                </button>
                <button
                  onClick={async () => {
                    if (previewFile.downloadPath) {
                      const tab = window.open("", "_blank");
                      try {
                        const blob = await fetchAuthenticatedFile(previewFile, authToken, CONVEX_ENV);
                        if (blob && tab) tab.location.href = URL.createObjectURL(blob);
                      } catch (err) {
                        tab?.close();
                        setStatusMsg(`Could not open ${previewFile.fileName}: ${getErrorMessage(err)}`);
                        setTimeout(() => setStatusMsg(null), 5000);
                      }
                      return;
                    }
                    const storedUrl = resolveStoredFileUrl(previewFile);
                    if (storedUrl) {
                      window.open(storedUrl, "_blank");
                      return;
                    }
                    const storedText = resolveStoredFileText(previewFile);
                    if (storedText) {
                      const blob = new Blob([storedText], { type: "text/plain;charset=utf-8" });
                      window.open(URL.createObjectURL(blob), "_blank");
                    }
                  }}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition flex items-center gap-1"
                  title="Open the stored document in a new browser tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPreviewFile(null)}
                  className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg transition"
                  aria-label="Close document preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 bg-slate-950 space-y-4">
              {isServedArchiveRecord(previewFile) && REAL_DOCUMENTS[previewFile.fileName] ? (
                <div className="space-y-4 text-xs">
                  <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
                    <h4 className="font-bold text-white text-sm mb-1">{REAL_DOCUMENTS[previewFile.fileName].title}</h4>
                    <p className="text-emerald-400 text-xs font-mono">{REAL_DOCUMENTS[previewFile.fileName].subtitle}</p>
                  </div>
                  {REAL_DOCUMENTS[previewFile.fileName].sections.map((sec, idx) => (
                    <div key={idx} className="bg-slate-900 border border-slate-800/80 rounded-xl p-4">
                      <h5 className="font-bold text-sky-400 mb-2 border-b border-slate-800 pb-1.5 font-mono text-[11px] tracking-wider uppercase">
                        {sec.heading}
                      </h5>
                      <div className="space-y-1.5 text-slate-300 font-mono text-[11px] leading-relaxed">
                        {sec.lines.map((line, lIdx) => (
                          <p key={lIdx}>{line}</p>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : previewFile.textContent ? (
                <pre className="whitespace-pre-wrap font-mono text-xs bg-slate-900 p-4 rounded-xl border border-slate-800/80 leading-relaxed text-slate-200">
                  {previewFile.textContent}
                </pre>
              ) : (
                <div className="text-xs text-slate-300 bg-slate-900 p-4 rounded-xl border border-slate-800/80 leading-relaxed">
                  <p className="font-semibold text-white mb-1">No inline preview available for {previewFile.fileName}.</p>
                  <p className="text-slate-400">
                    This record stores a binary object in Convex Storage. Use Download or the open-in-new-tab action to view the stored bytes.
                  </p>
                </div>
              )}
            </div>

            <div className="p-3 border-t border-slate-800 bg-slate-900 flex items-center justify-between text-xs">
              <span className="text-[11px] text-slate-400">
                {isServedArchiveRecord(previewFile)
                  ? `Seeded project document • ${FILE_TYPE_LABELS[previewFile.fileType] || previewFile.fileType} • served from the app document archive`
                  : `Stored in Convex _storage • ${FILE_TYPE_LABELS[previewFile.fileType] || previewFile.fileType} • uploaded ${formatDateOnly(previewFile.uploadedAt)}`}
              </span>
              <button
                onClick={() => setPreviewFile(null)}
                className="bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs px-3 py-1.5 rounded-lg transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(fileToDelete)}
        title="Delete file?"
        description={fileToDelete ? `Permanently remove ${fileToDelete.fileName} from this project's document register and storage?` : ""}
        confirmLabel="Delete file"
        onCancel={() => setFileToDelete(null)}
        onConfirm={confirmDeleteFile}
      />
    </div>
  );
};
