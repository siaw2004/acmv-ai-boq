"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

type ItemName = "FCU" | "VCD" | "Diffuser" | "OBD" | "Grille" | "FD" | "FSD";

type BoqItem = {
  item: ItemName;
  quantity: number;
};

type Detection = {
  id: number;
  item: ItemName;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  score: number;
};

const ITEM_NAMES: ItemName[] = [
  "FCU",
  "VCD",
  "Diffuser",
  "OBD",
  "Grille",
  "FD",
  "FSD",
];

function createInitialBoq(): BoqItem[] {
  return [
    { item: "FCU", quantity: 0 },
    { item: "VCD", quantity: 0 },
    { item: "Diffuser", quantity: 0 },
    { item: "OBD", quantity: 0 },
    { item: "Grille", quantity: 0 },
    { item: "FD", quantity: 0 },
    { item: "FSD", quantity: 0 },
  ];
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [detectionMode, setDetectionMode] = useState<"symbol" | "text">("symbol");

  const [selectedTool, setSelectedTool] = useState<ItemName>("FCU");
  const [symbolThreshold, setSymbolThreshold] = useState(0.62);
  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [samplePreviewUrl, setSamplePreviewUrl] = useState("");
  const [isSymbolScanning, setIsSymbolScanning] = useState(false);

  const [detections, setDetections] = useState<Detection[]>([]);

  const [textKeywords, setTextKeywords] = useState("VCD,FD,FSD");
  const [textScanResult, setTextScanResult] = useState<Record<string, number> | null>(null);
  const [textRawResult, setTextRawResult] = useState("");
  const [isTextScanning, setIsTextScanning] = useState(false);

  const [boq, setBoq] = useState<BoqItem[]>(createInitialBoq());
  const [status, setStatus] = useState("Upload drawing and choose a detection mode.");
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (samplePreviewUrl) URL.revokeObjectURL(samplePreviewUrl);
    };
  }, [previewUrl, samplePreviewUrl]);

  const handleDrawingChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (previewUrl) URL.revokeObjectURL(previewUrl);

    setFile(selectedFile);
    setPreviewUrl(URL.createObjectURL(selectedFile));
    setDetections([]);
    setTextScanResult(null);
    setTextRawResult("");
    setBoq(createInitialBoq());
    setStatus("Drawing uploaded successfully.");
  };

  const handleSampleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    if (samplePreviewUrl) URL.revokeObjectURL(samplePreviewUrl);

    setSampleFile(selectedFile);
    setSamplePreviewUrl(URL.createObjectURL(selectedFile));
    setStatus("Sample uploaded successfully.");
  };

  const runSymbolScan = async () => {
    if (!file) {
      alert("Please upload a drawing image first.");
      return;
    }

    if (!sampleFile) {
      alert("Please upload a sample image first.");
      return;
    }

    const formData = new FormData();
    formData.append("drawing", file);
    formData.append("sample", sampleFile);
    formData.append("item_name", selectedTool);
    formData.append("threshold", String(symbolThreshold));

    try {
      setIsSymbolScanning(true);
      setStatus(`Scanning symbol for ${selectedTool}...`);
      setDetections([]);

      const response = await fetch("http://127.0.0.1:8000/match-symbol", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Symbol scan failed.");
      }

      const drawingScaleRatio = data.drawing_scale_ratio || 1;
      const apiDetections = (data.detections || []).map(
        (det: { x: number; y: number; w: number; h: number; score: number }, index: number) => ({
          id: Date.now() + index,
          item: selectedTool,
          xPercent: det.x,
          yPercent: det.y,
          widthPercent: det.w,
          heightPercent: det.h,
          score: det.score,
          drawingScaleRatio,
        })
      );

      if (imgRef.current) {
        const scaledImageWidth = imgRef.current.naturalWidth * drawingScaleRatio;
        const scaledImageHeight = imgRef.current.naturalHeight * drawingScaleRatio;

        const normalizedDetections: Detection[] = apiDetections.map(
          (det: {
            id: number;
            item: ItemName;
            xPercent: number;
            yPercent: number;
            widthPercent: number;
            heightPercent: number;
            score: number;
          }) => ({
            id: det.id,
            item: det.item,
            xPercent: (det.xPercent / scaledImageWidth) * 100,
            yPercent: (det.yPercent / scaledImageHeight) * 100,
            widthPercent: (det.widthPercent / scaledImageWidth) * 100,
            heightPercent: (det.heightPercent / scaledImageHeight) * 100,
            score: det.score,
          })
        );

        setDetections(normalizedDetections);
      }

      setBoq((prev) =>
        prev.map((item) =>
          item.item === selectedTool
            ? { ...item, quantity: data.count || 0 }
            : item
        )
      );

      setStatus(`${selectedTool} scan completed. Found ${data.count || 0} matches.`);
    } catch (error) {
      console.error(error);
      alert("Symbol scan failed.");
      setStatus("Symbol scan failed.");
    } finally {
      setIsSymbolScanning(false);
    }
  };

  const normalizeTextKeyToBoqItem = (key: string): ItemName | null => {
    const upper = key.toUpperCase().trim();

    if (upper === "FCU") return "FCU";
    if (upper === "VCD") return "VCD";
    if (upper === "OBD") return "OBD";
    if (upper === "FD") return "FD";
    if (upper === "FSD") return "FSD";

    if (
      upper === "GRILLE" ||
      upper === "BAR GRILLE" ||
      upper === "EA GRILLE" ||
      upper === "SA GRILLE"
    ) {
      return "Grille";
    }

    if (
      upper === "DIFFUSER" ||
      upper === "DIFF" ||
      upper === "SUPPLY DIFFUSER"
    ) {
      return "Diffuser";
    }

    return null;
  };

  const runTextScan = async () => {
    if (!file) {
      alert("Please upload a drawing image first.");
      return;
    }

    const formData = new FormData();
    formData.append("drawing", file);
    formData.append("keywords", textKeywords);

    try {
      setIsTextScanning(true);
      setStatus("Scanning text labels...");
      setTextScanResult(null);
      setTextRawResult("");

      const response = await fetch("http://127.0.0.1:8000/scan-text-labels", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Text scan failed.");
      }

      const counts = data.counts || {};
      setTextScanResult(counts);
      setTextRawResult(data.raw_text || "");

      setBoq((prev) => {
        const next = createInitialBoq();

        for (const [key, value] of Object.entries(counts)) {
          const mappedItem = normalizeTextKeyToBoqItem(key);
          if (!mappedItem) continue;

          const row = next.find((item) => item.item === mappedItem);
          if (row) row.quantity += Number(value) || 0;
        }

        return next.map((row) => {
          const old = prev.find((p) => p.item === row.item);
          if (!old) return row;
          return row.quantity > 0 ? row : { ...row, quantity: old.quantity };
        });
      });

      setStatus("Text label scan completed.");
    } catch (error) {
      console.error(error);
      alert("Text scan failed.");
      setStatus("Text scan failed.");
    } finally {
      setIsTextScanning(false);
    }
  };

  const removeDetection = (detectionId: number, itemName: ItemName) => {
    setDetections((prev) => prev.filter((d) => d.id !== detectionId));
    setBoq((prev) =>
      prev.map((item) =>
        item.item === itemName
          ? { ...item, quantity: Math.max(0, item.quantity - 1) }
          : item
      )
    );
  };

  const increaseItem = (itemName: ItemName) => {
    setBoq((prev) =>
      prev.map((item) =>
        item.item === itemName
          ? { ...item, quantity: item.quantity + 1 }
          : item
      )
    );
  };

  const decreaseItem = (itemName: ItemName) => {
    setBoq((prev) =>
      prev.map((item) =>
        item.item === itemName
          ? { ...item, quantity: Math.max(0, item.quantity - 1) }
          : item
      )
    );
  };

  const exportToExcel = () => {
    const worksheet = XLSX.utils.json_to_sheet(boq);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "BOQ");
    XLSX.writeFile(workbook, "boq_report.xlsx");
  };

  const resetAll = () => {
    setBoq(createInitialBoq());
    setDetections([]);
    setTextScanResult(null);
    setTextRawResult("");
    setStatus("All results cleared.");
  };

  const totalCount = useMemo(() => {
    return boq.reduce((sum, item) => sum + item.quantity, 0);
  }, [boq]);

  const isImage = file?.type.startsWith("image/");
  const isPdf = file?.type === "application/pdf";

  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-7xl rounded-2xl bg-white p-6 shadow">
        <h1 className="mb-2 text-3xl font-bold">ACMV BOQ AI Tool</h1>
        <p className="mb-6 text-gray-600">
          Hybrid workflow: symbol matching for graphic symbols, text scan for labeled items.
        </p>

        <div className="mb-6 rounded-xl border bg-white p-4">
          <h2 className="mb-3 text-xl font-semibold">Detection Mode</h2>
          <div className="flex gap-3">
            <button
              onClick={() => setDetectionMode("symbol")}
              className={`rounded-xl px-5 py-3 text-white ${
                detectionMode === "symbol"
                  ? "bg-orange-600 hover:bg-orange-700"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              Symbol Detection
            </button>

            <button
              onClick={() => setDetectionMode("text")}
              className={`rounded-xl px-5 py-3 text-white ${
                detectionMode === "text"
                  ? "bg-orange-600 hover:bg-orange-700"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              Text Label Detection
            </button>
          </div>
        </div>

        <div className="mb-6 rounded-xl border-2 border-dashed border-blue-400 bg-blue-50 p-6">
          <p className="mb-3 text-lg font-semibold text-blue-800">
            Upload Drawing File
          </p>

          <label className="inline-block cursor-pointer rounded-xl bg-blue-600 px-5 py-3 font-medium text-white hover:bg-blue-700">
            Choose Drawing
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg"
              onChange={handleDrawingChange}
              className="hidden"
            />
          </label>

          <p className="mt-3 text-sm text-gray-600">
            Supported: PDF, PNG, JPG, JPEG
          </p>
        </div>

        {file && (
          <div className="mb-6 rounded-lg border bg-gray-50 p-4">
            <p className="font-medium">Uploaded drawing:</p>
            <p className="text-sm text-gray-700">{file.name}</p>
          </div>
        )}

        {detectionMode === "symbol" && (
          <div className="mb-6 rounded-xl border bg-white p-4">
            <h2 className="mb-3 text-xl font-semibold">Symbol Detection</h2>

            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {ITEM_NAMES.map((item) => (
                <button
                  key={item}
                  onClick={() => setSelectedTool(item)}
                  className={`rounded-xl px-4 py-3 text-white ${
                    selectedTool === item
                      ? "bg-orange-600 hover:bg-orange-700"
                      : "bg-blue-600 hover:bg-blue-700"
                  }`}
                >
                  {selectedTool === item ? "Selected: " : ""}
                  {item}
                </button>
              ))}
            </div>

            <div className="mb-4">
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Similarity Threshold: {symbolThreshold.toFixed(2)}
              </label>
              <input
                type="range"
                min="0.45"
                max="0.90"
                step="0.01"
                value={symbolThreshold}
                onChange={(e) => setSymbolThreshold(Number(e.target.value))}
                className="w-full"
              />
              <p className="mt-1 text-xs text-gray-500">
                Lower = looser, higher = stricter
              </p>
            </div>

            <div className="mb-4">
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Upload Sample Image
              </label>
              <input
                type="file"
                accept=".png,.jpg,.jpeg"
                onChange={handleSampleChange}
                className="block w-full rounded-lg border p-3"
              />
            </div>

            {samplePreviewUrl && (
              <div className="mb-4">
                <p className="mb-2 text-sm font-medium text-gray-700">Sample Preview</p>
                <img
                  src={samplePreviewUrl}
                  alt="Sample preview"
                  className="max-h-40 rounded-lg border"
                />
              </div>
            )}

            <button
              onClick={runSymbolScan}
              className="rounded-xl bg-emerald-600 px-5 py-3 text-white hover:bg-emerald-700"
              disabled={isSymbolScanning}
            >
              {isSymbolScanning ? "Scanning..." : "Find Symbol Matches"}
            </button>
          </div>
        )}

        {detectionMode === "text" && (
          <div className="mb-6 rounded-xl border bg-white p-4">
            <h2 className="mb-3 text-xl font-semibold">Text Label Detection</h2>

            <label className="mb-2 block text-sm font-medium text-gray-700">
              Keywords (comma separated)
            </label>
            <input
              type="text"
              value={textKeywords}
              onChange={(e) => setTextKeywords(e.target.value)}
              className="mb-4 w-full rounded-lg border p-3"
              placeholder="Example: VCD,FD,FSD,BAR GRILLE"
            />

            <button
              onClick={runTextScan}
              className="rounded-xl bg-purple-600 px-5 py-3 text-white hover:bg-purple-700"
              disabled={isTextScanning}
            >
              {isTextScanning ? "Scanning..." : "Scan Text Labels"}
            </button>

            {textScanResult && (
              <div className="mt-4 rounded-lg border bg-gray-50 p-4">
                <h3 className="mb-3 text-lg font-semibold">Detected Counts</h3>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {Object.entries(textScanResult).map(([key, value]) => (
                    <div key={key} className="rounded border bg-white p-3">
                      <p className="text-sm text-gray-500">{key}</p>
                      <p className="text-2xl font-bold">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {textRawResult && (
              <div className="mt-4">
                <h3 className="mb-2 text-lg font-semibold">OCR Raw Text</h3>
                <textarea
                  value={textRawResult}
                  readOnly
                  className="h-48 w-full rounded-lg border p-3 text-sm"
                />
              </div>
            )}
          </div>
        )}

        <div className="mb-6 rounded-xl border bg-white p-4">
          <h2 className="mb-3 text-xl font-semibold">Current Status</h2>
          <p className="text-sm text-gray-700">{status}</p>
          <p className="mt-2 text-sm text-gray-700">
            <span className="font-semibold">Total Quantity:</span> {totalCount}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              onClick={resetAll}
              className="rounded-xl bg-black px-5 py-3 text-white hover:bg-gray-900"
            >
              Reset Results
            </button>

            <button
              onClick={exportToExcel}
              className="rounded-xl bg-green-600 px-5 py-3 text-white hover:bg-green-700"
            >
              Export to Excel
            </button>
          </div>
        </div>

        {previewUrl && (
          <div className="mb-6 rounded-xl border bg-white p-4">
            <h2 className="mb-3 text-xl font-semibold">Drawing Preview</h2>

            {isImage && (
              <div className="relative inline-block">
                <img
                  ref={imgRef}
                  src={previewUrl}
                  alt="Drawing preview"
                  className="block max-h-175 max-w-full rounded-lg border"
                />

                {detections.map((det) => (
                  <button
                    key={det.id}
                    onClick={() => removeDetection(det.id, det.item)}
                    className="absolute border-2 border-green-500 bg-green-200/10 text-left"
                    style={{
                      left: `${det.xPercent}%`,
                      top: `${det.yPercent}%`,
                      width: `${det.widthPercent}%`,
                      height: `${det.heightPercent}%`,
                    }}
                    title={`${det.item} | score: ${det.score.toFixed(3)} | click to remove`}
                  >
                    <span className="absolute left-0 top-0 bg-green-600 px-1 text-[10px] font-bold text-white">
                      {det.item}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {isPdf && (
              <iframe
                src={previewUrl}
                title="PDF Preview"
                className="h-175 w-full rounded-lg border"
              />
            )}
          </div>
        )}

        <div className="mb-6 overflow-hidden rounded-xl border">
          <table className="w-full text-left">
            <thead className="bg-gray-200">
              <tr>
                <th className="p-3">Item</th>
                <th className="p-3">Quantity</th>
                <th className="p-3">Adjust</th>
              </tr>
            </thead>
            <tbody>
              {boq.map((item) => (
                <tr key={item.item} className="border-t">
                  <td className="p-3">{item.item}</td>
                  <td className="p-3">{item.quantity}</td>
                  <td className="p-3">
                    <div className="flex gap-2">
                      <button
                        onClick={() => increaseItem(item.item)}
                        className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700"
                      >
                        +
                      </button>
                      <button
                        onClick={() => decreaseItem(item.item)}
                        className="rounded bg-gray-600 px-3 py-1 text-white hover:bg-gray-700"
                      >
                        -
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}