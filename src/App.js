import { useState, useRef, useEffect, useCallback } from "react";

// Import Worker
import { Worker } from "@react-pdf-viewer/core";
// Import the main Viewer component
import { Viewer } from "@react-pdf-viewer/core";
// Import the styles
import "@react-pdf-viewer/core/lib/styles/index.css";
// default layout plugin
import { defaultLayoutPlugin } from "@react-pdf-viewer/default-layout";
// Import styles of default layout plugin
import "@react-pdf-viewer/default-layout/lib/styles/index.css";

// ──────────────────────────────────────────────
// Paragraph-detection helpers (pure functions)
// ──────────────────────────────────────────────

/** Find the closest text-layer ancestor of a DOM node */
const findTextLayer = (node) => {
  let el = node;
  while (el) {
    if (
      el.classList &&
      (el.classList.contains("rpv-core__text-layer") ||
        el.classList.contains("textLayer"))
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
};

/**
 * Given a text-layer element, group its child <span>s into paragraphs.
 * Returns an array of { spans: HTMLElement[] } objects.
 */
const buildParagraphs = (textLayer) => {
  const spans = Array.from(textLayer.querySelectorAll("span")).filter(
    (sp) => sp.offsetWidth > 0 && sp.offsetHeight > 0,
  );
  if (spans.length === 0) return [];

  // Build "line" groups: spans sharing approximately the same offsetTop
  const EPS = 4; // px tolerance
  const lines = [];
  const sorted = [...spans].sort((a, b) => a.offsetTop - b.offsetTop);

  let curLine = { top: sorted[0].offsetTop, spans: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    const sp = sorted[i];
    if (Math.abs(sp.offsetTop - curLine.top) <= EPS) {
      curLine.spans.push(sp);
    } else {
      lines.push(curLine);
      curLine = { top: sp.offsetTop, spans: [sp] };
    }
  }
  lines.push(curLine);

  // Compute median line height
  const lineHeights = lines
    .map((l) => {
      const bottoms = l.spans.map((s) => s.offsetTop + s.offsetHeight);
      return Math.max(...bottoms) - l.top;
    })
    .sort((a, b) => a - b);
  const medianLH = lineHeights[Math.floor(lineHeights.length / 2)] || 16;

  // Merge lines into paragraphs by vertical gap
  const paragraphs = [];
  let curPara = { lines: [lines[0]], bottom: lines[0].top + medianLH };
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    const gap = ln.top - curPara.bottom;
    if (gap <= Math.max(4, medianLH * 0.9)) {
      curPara.lines.push(ln);
      curPara.bottom = ln.top + medianLH;
    } else {
      paragraphs.push(curPara);
      curPara = { lines: [ln], bottom: ln.top + medianLH };
    }
  }
  paragraphs.push(curPara);

  // Flatten each paragraph to its span list
  return paragraphs.map((p) => ({
    spans: p.lines.flatMap((l) => l.spans),
  }));
};

const HIGHLIGHT_CLASS = "pdf-para-highlight";

// ──────────────────────────────────────────────
// App component
// ──────────────────────────────────────────────

function App() {
  // creating new plugin instance
  const defaultLayoutPluginInstance = defaultLayoutPlugin();

  // pdf file onChange state
  const [pdfFile, setPdfFile] = useState(null);

  // pdf file error state
  const [pdfError, setPdfError] = useState("");

  // ref for the outer viewer wrapper
  const viewerRef = useRef(null);
  // cache: textLayer element → paragraphs[]
  const paraCache = useRef(new WeakMap());
  // currently highlighted spans
  const prevSpans = useRef([]);
  const hoverTimer = useRef(0);

  // set of already-highlighted paragraph keys (to avoid re-processing)
  const highlightedParas = useRef(new Set());

  /** Clear all highlights (used when PDF changes) */
  const clearAllHighlights = useCallback(() => {
    prevSpans.current.forEach((sp) => sp.classList.remove(HIGHLIGHT_CLASS));
    prevSpans.current = [];
    highlightedParas.current.clear();
  }, []);

  /** Core handler: detect paragraph under pointer and add persistent highlight.
   *  Highlights accumulate — they stay as long as the PDF is open. */
  const onPointerMove = useCallback((e) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      // 1. Find the element under the pointer
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target) return;

      // 2. Walk up to find the text layer
      const textLayer = findTextLayer(target);
      if (!textLayer) return;

      // 3. Build (or retrieve cached) paragraphs for this text layer
      let paragraphs = paraCache.current.get(textLayer);
      if (!paragraphs) {
        paragraphs = buildParagraphs(textLayer);
        paraCache.current.set(textLayer, paragraphs);
      }

      // 4. Find which paragraph contains the hovered span
      const hoveredSpan = target.closest("span");
      if (!hoveredSpan) return;

      const paraIdx = paragraphs.findIndex((p) =>
        p.spans.includes(hoveredSpan),
      );
      if (paraIdx === -1) return;

      // 5. If this paragraph is already highlighted, skip
      const paraKey = `${textLayer.dataset.rpvPageIndex || ""}_${paraIdx}`;
      if (highlightedParas.current.has(paraKey)) return;

      // 6. Add highlight (keep all previous ones)
      highlightedParas.current.add(paraKey);
      const para = paragraphs[paraIdx];
      para.spans.forEach((sp) => sp.classList.add(HIGHLIGHT_CLASS));
      prevSpans.current.push(...para.spans);
    }, 80);
  }, []);

  /** Invalidate paragraph cache on DOM changes (zoom, page render) */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    // Clear all highlights when PDF changes
    clearAllHighlights();

    const invalidateCache = () => {
      paraCache.current = new WeakMap();
    };

    const mo = new MutationObserver(invalidateCache);
    mo.observe(viewer, { childList: true, subtree: true });

    viewer.addEventListener("pointermove", onPointerMove);

    return () => {
      mo.disconnect();
      viewer.removeEventListener("pointermove", onPointerMove);
    };
  }, [pdfFile, onPointerMove, clearAllHighlights]);

  // handle file onChange event
  const allowedFiles = ["application/pdf"];
  const handleFile = (e) => {
    let selectedFile = e.target.files[0];
    if (selectedFile) {
      if (selectedFile && allowedFiles.includes(selectedFile.type)) {
        let reader = new FileReader();
        reader.readAsDataURL(selectedFile);
        reader.onloadend = (e) => {
          setPdfError("");
          setPdfFile(e.target.result);
        };
      } else {
        setPdfError("Not a valid pdf: Please select only PDF");
        setPdfFile("");
      }
    } else {
      console.log("please select a PDF");
    }
  };

  return (
    <div className="container">
      {/* Upload PDF */}
      <form>
        <label>
          <h5>Upload PDF</h5>
        </label>
        <br></br>

        <input
          type="file"
          className="form-control"
          onChange={handleFile}
        ></input>

        {pdfError && <span className="text-danger">{pdfError}</span>}
      </form>

      {/* View PDF */}
      <h5>View PDF</h5>
      <div className="viewer" ref={viewerRef}>
        {/* render this if we have a pdf file */}
        {pdfFile && (
          <Worker workerUrl="https://unpkg.com/pdfjs-dist@2.12.313/build/pdf.worker.min.js">
            <Viewer
              fileUrl={pdfFile}
              plugins={[defaultLayoutPluginInstance]}
            ></Viewer>
          </Worker>
        )}

        {/* render this if we have pdfFile state null   */}
        {!pdfFile && <>No file is selected yet</>}
      </div>
    </div>
  );
}

export default App;
