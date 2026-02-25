import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  DragOverlay,
  PointerSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'framer-motion';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, UIEvent, WheelEvent as ReactWheelEvent } from 'react';
import { SortableCard } from './SortableCard';
import {
  ApiError,
  type AuthUser,
  type ProfileUpdatePayload,
  addRemoteComment,
  deleteRemoteComment,
  getAuthToken,
  loadRemoteArchivedComments,
  loadRemoteBoard,
  setRemoteCardChecklist,
  setRemoteCardFavorite,
  restoreRemoteArchivedComment,
  updateRemoteComment,
} from '../auth/api';
import { useI18n, formatHistoryDelta } from '../i18n';
import { LanguageToggle } from '../i18n/LanguageToggle';

import type { BoardState, ColumnId, Card, HistoryEntry, HistoryKind, Urgency } from './types';
import { loadState, markStateAsRemoteSynced } from './storage';

import type { UndoPayload } from './actions';
import { boardReducer } from './reducer';
import { useDebouncedPersist } from './useDebouncedPersist';
import { useDebouncedValue } from './useDebouncedValue';
import { buildCardColumnMap, isColumnId, findColumnOfCard, computeDoingMs } from './selectors';
import { useMotionProfile } from './useMotionProfile';
import { richCommentToPlainText } from './richComment';
import { sanitizeCardImages } from './cardImages';
import { BOARD_PERF, clampColumnVirtualRowEstimate, resolveHistoryVirtualizeThreshold } from './perfConfig';

const CardModal = lazy(() =>
  import('./CardModal').then((mod) => ({
    default: mod.CardModal,
  }))
);

const EditModal = lazy(() =>
  import('./EditModal').then((mod) => ({
    default: mod.EditModal,
  }))
);

const ProfileModal = lazy(() =>
  import('./ProfileModal').then((mod) => ({
    default: mod.ProfileModal,
  }))
);

const columns = [
  { id: 'queue', accent: 'accentQueue' },
  { id: 'doing', accent: 'accentDoing' },
  { id: 'review', accent: 'accentReview' },
  { id: 'done', accent: 'accentDone' },
] as const;

const FREE_CANVAS_DROPPABLE_ID = 'free-canvas';
const FAVORITE_DND_PREFIX = 'fav:';
const FAVORITES_DROPPABLE_ID = 'favorites-dropzone';
const FLOATING_SIDE_PAD = 8;
const FLOATING_BOTTOM_PAD = 8;
const FLOATING_TOP_PAD = 40;

type UrgFilter = 'all' | Urgency;
type FloatingNailTone = 'slate' | 'sage' | 'amber' | 'violet' | 'rose';

const FLOATING_NAIL_TONES: FloatingNailTone[] = ['slate', 'sage', 'amber', 'violet', 'rose'];

const FILTERS: Array<{ key: UrgFilter; labelKey: string; dot?: Urgency }> = [
  { key: 'all', labelKey: 'urgency.all' },
  { key: 'white', labelKey: 'urgency.white', dot: 'white' },
  { key: 'yellow', labelKey: 'urgency.yellow', dot: 'yellow' },
  { key: 'pink', labelKey: 'urgency.pink', dot: 'pink' },
  { key: 'red', labelKey: 'urgency.red', dot: 'red' },
];

const COLUMN_TITLE_KEY: Record<ColumnId, string> = {
  queue: 'column.queue',
  doing: 'column.doing',
  review: 'column.review',
  done: 'column.done',
};

const EMPTY_COLUMN_TEXT_KEY: Record<ColumnId, string> = {
  queue: 'empty.queue',
  doing: 'empty.doing',
  review: 'empty.review',
  done: 'empty.done',
};

const FAVORITE_STATUS_LABEL_KEY: Record<ColumnId | 'freedom', string> = {
  queue: 'column.queue',
  doing: 'column.doing',
  review: 'column.review',
  done: 'column.done',
  freedom: 'column.freedom',
};

type HistoryFilterKey = 'all' | 'create' | 'move' | 'delete' | 'restore';

type HistoryVirtualRow =
  | {
      kind: 'group';
      key: string;
      label: string;
    }
  | {
      kind: 'item';
      key: string;
      entry: HistoryEntry;
    };

const HISTORY_FILTERS: Array<{ key: HistoryFilterKey; labelKey: string }> = [
  { key: 'all', labelKey: 'history.filter.all' },
  { key: 'create', labelKey: 'history.filter.create' },
  { key: 'move', labelKey: 'history.filter.move' },
  { key: 'delete', labelKey: 'history.filter.delete' },
  { key: 'restore', labelKey: 'history.filter.restore' },
];

function nailToneFromSwayOffset(swayOffsetMs: number): FloatingNailTone {
  const safe = Number.isFinite(swayOffsetMs) ? Math.abs(Math.trunc(swayOffsetMs)) : 0;
  return FLOATING_NAIL_TONES[safe % FLOATING_NAIL_TONES.length];
}

function historyKindFromText(text: string): HistoryKind {
  const norm = text.toLowerCase();
  if (norm.includes('восстанов') || norm.includes('restor')) return 'restore';
  if (norm.includes('удален') || norm.includes('delete')) return 'delete';
  if (norm.includes('перемещ') || norm.includes('move')) return 'move';
  return 'create';
}

function historyKind(entry: HistoryEntry): HistoryKind {
  if (entry.kind === 'create' || entry.kind === 'move' || entry.kind === 'delete' || entry.kind === 'restore') {
    return entry.kind;
  }
  return historyKindFromText(entry.text);
}

function startOfLocalDay(ts: number) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function historyDayLabel(
  ts: number,
  nowTs: number,
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string
) {
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const todayStart = startOfLocalDay(nowTs);
  const diffDays = Math.floor((todayStart - startOfLocalDay(ts)) / 86_400_000);
  if (diffDays === 0) return t('history.today');
  if (diffDays === 1) return t('history.yesterday');
  return dateFormatter.format(ts);
}

function formatDateTime(ts: number, locale: string) {
  const dtFormatter = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return dtFormatter.format(ts);
}

function historyTitle(entry: HistoryEntry, untitled: string) {
  const fromMeta = (entry.meta?.title ?? '').trim();
  if (fromMeta) return fromMeta;

  const m = entry.text.match(/"(.*?)"/);
  const fromText = m?.[1]?.trim() ?? '';
  return fromText || untitled;
}

function historyText(
  entry: HistoryEntry,
  t: (key: string, vars?: Record<string, string | number>) => string
) {
  const hasStructured =
    !!entry.meta &&
    (entry.kind === 'create' || entry.kind === 'move' || entry.kind === 'delete' || entry.kind === 'restore');
  if (!hasStructured) return entry.text;

  const kind = historyKind(entry);
  const title = historyTitle(entry, t('common.untitled'));
  const fromCol = entry.meta?.fromCol && COLUMN_TITLE_KEY[entry.meta.fromCol] ? t(COLUMN_TITLE_KEY[entry.meta.fromCol]) : t('column.queue');
  const toCol = entry.meta?.toCol && COLUMN_TITLE_KEY[entry.meta.toCol] ? t(COLUMN_TITLE_KEY[entry.meta.toCol]) : t('column.queue');
  const doingDeltaMs = Number(entry.meta?.doingDeltaMs ?? 0) || 0;

  let base = '';
  if (kind === 'create') base = t('history.event.create', { title, to: toCol });
  if (kind === 'move') base = t('history.event.move', { title, from: fromCol, to: toCol });
  if (kind === 'delete') base = t('history.event.delete', { title, from: fromCol });
  if (kind === 'restore') base = t('history.event.restore', { title, to: toCol });

  if (kind === 'move' || kind === 'restore') {
    const fromDoing = entry.meta?.fromCol === 'doing';
    const toDoing = entry.meta?.toCol === 'doing';
    if (toDoing && !fromDoing) base += t('history.event.timer.started');
    if (fromDoing && !toDoing) {
      if (doingDeltaMs > 0) base += t('history.event.timer.delta', { delta: formatHistoryDelta(doingDeltaMs, t) });
      else base += t('history.event.timer.stopped');
    }
  }

  if (kind === 'delete' && entry.meta?.fromCol === 'doing') {
    if (doingDeltaMs > 0) base += t('history.event.timer.delta', { delta: formatHistoryDelta(doingDeltaMs, t) });
    else base += t('history.event.timer.stopped');
  }

  return base || entry.text;
}

function findVirtualOffsetIndex(offsets: number[], targetOffset: number): number {
  if (offsets.length <= 1) return 0;
  const clamped = Math.max(0, targetOffset);
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (offsets[mid] <= clamped) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, Math.min(low, offsets.length - 2));
}

function SearchGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <path d="M16 16L20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function FilterGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path d="M3 5.75C3 5.34 3.34 5 3.75 5h16.5a.75.75 0 0 1 .58 1.23L14.5 14v5.25a.75.75 0 0 1-1.2.6l-2.5-1.88a.75.75 0 0 1-.3-.6V14L3.17 6.23A.75.75 0 0 1 3 5.75Z" fill="currentColor" />
    </svg>
  );
}

function StarGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path
        d="m12 3.7 2.45 4.95 5.46.8-3.95 3.85.93 5.44L12 16.17l-4.89 2.57.93-5.44-3.95-3.85 5.46-.8L12 3.7Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CommentsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path
        d="M6.45 6.35h11.1A2.2 2.2 0 0 1 19.75 8.55v6.2a2.2 2.2 0 0 1-2.2 2.2h-5.26l-3.64 2.4v-2.4H6.45a2.2 2.2 0 0 1-2.2-2.2v-6.2a2.2 2.2 0 0 1 2.2-2.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.95"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.2 10.15h7.2M8.2 13.15h5.35" fill="none" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" />
    </svg>
  );
}

function ChecklistGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path
        d="M7.2 6.4h10.2M7.2 11.9h10.2M7.2 17.4h10.2M4.7 6.4h.1M4.7 11.9h.1M4.7 17.4h.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

type SegmentId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

const SEVEN_SEGMENT_ORDER: SegmentId[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const SEVEN_SEGMENT_MAP: Record<string, SegmentId[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'g', 'e', 'd'],
  '3': ['a', 'b', 'g', 'c', 'd'],
  '4': ['f', 'g', 'b', 'c'],
  '5': ['a', 'f', 'g', 'c', 'd'],
  '6': ['a', 'f', 'g', 'e', 'c', 'd'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
};

function SevenSegmentDigit({ digit }: { digit: string }) {
  const active = SEVEN_SEGMENT_MAP[digit] ?? [];
  return (
    <span className={`segDigit ${digit === '1' ? 'isOne' : ''}`} aria-hidden="true">
      {SEVEN_SEGMENT_ORDER.map((seg) => (
        <span key={seg} className={`segSeg seg-${seg} ${active.includes(seg) ? 'isOn' : ''}`} />
      ))}
    </span>
  );
}

function BoardClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const hhmm = `${hours}:${minutes}`;

  return (
    <div className="boardClock" title={hhmm} aria-label={hhmm}>
      <SevenSegmentDigit digit={hours[0]} />
      <SevenSegmentDigit digit={hours[1]} />
      <span className="boardClockColon" aria-hidden="true">
        <span className="boardClockColonDot" />
        <span className="boardClockColonDot" />
      </span>
      <SevenSegmentDigit digit={minutes[0]} />
      <SevenSegmentDigit digit={minutes[1]} />
    </div>
  );
}

function easeOutCubic(value: number) {
  const clamped = Math.min(1, Math.max(0, value));
  return 1 - Math.pow(1 - clamped, 3);
}

function seedFromString(input: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function CrumpleCanvasOverlay({
  card,
  reducedMotion,
  lowPower,
}: {
  card: Card;
  reducedMotion: boolean;
  lowPower: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseSeed = useMemo(() => seedFromString(card.id), [card.id]);
  const descriptionPreviewText = useMemo(() => richCommentToPlainText(card.description || ''), [card.description]);
  const contentPreview = useMemo(() => {
    return `${card.title || ''} ${descriptionPreviewText}`.trim().slice(0, 56);
  }, [card.title, descriptionPreviewText]);
  const overlayHeight = useMemo(() => {
    const titleLen = (card.title ?? '').trim().length;
    const descLen = descriptionPreviewText.trim().length;
    const lines = Math.min(7, Math.max(3, Math.ceil((titleLen + descLen) / 32)));
    return 102 + lines * 5;
  }, [card.title, descriptionPreviewText]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(bounds.width * dpr));
      canvas.height = Math.max(1, Math.round(bounds.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    };

    resize();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
    } else {
      window.addEventListener('resize', resize);
    }

    const startTs = performance.now();
    const ringCount = lowPower ? 18 : 26;
    const ringNoise = Array.from({ length: ringCount }, (_, idx) => {
      const seed = seedFromString(`${card.id}-${idx}`);
      return {
        amp: 0.08 + seed * 0.14,
        freq: 1.4 + seed * 2.8,
        phase: seed * Math.PI * 2,
      };
    });

    const drawRoundedRect = (x: number, y: number, w: number, h: number, radius: number) => {
      const r = Math.min(radius, Math.min(w, h) / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    let rafId = 0;
    const draw = (now: number) => {
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      ctx.clearRect(0, 0, width, height);

      const elapsed = now - startTs;
      const foldProgress = reducedMotion ? 1 : easeOutCubic(Math.min(1, elapsed / 260));
      const cardAlpha = 1 - Math.min(1, foldProgress * 1.1);
      const ballAlpha = Math.min(1, Math.max(0, (foldProgress - 0.16) / 0.84));

      const cx = width * 0.5;
      const cy = height * 0.52;
      const animPhase = elapsed / 700;

      const shadowRadiusX = (28 + foldProgress * 18) * (1 + Math.sin(animPhase * 0.8) * 0.02);
      const shadowRadiusY = 9 + foldProgress * 3;
      ctx.save();
      ctx.translate(cx, cy + 36);
      ctx.scale(1 + foldProgress * 0.12, 1);
      const shadowGradient = ctx.createRadialGradient(0, 0, 2, 0, 0, shadowRadiusX);
      shadowGradient.addColorStop(0, 'rgba(15,23,42,0.2)');
      shadowGradient.addColorStop(1, 'rgba(15,23,42,0)');
      ctx.fillStyle = shadowGradient;
      ctx.beginPath();
      ctx.ellipse(0, 0, shadowRadiusX, shadowRadiusY, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (cardAlpha > 0.01) {
        const rectW = width * (0.94 - foldProgress * 0.46);
        const rectH = height * (0.86 - foldProgress * 0.4);
        const rectX = cx - rectW / 2;
        const rectY = cy - rectH / 2;
        const rectRadius = 12 + foldProgress * (rectH * 0.3);

        ctx.save();
        ctx.globalAlpha = cardAlpha;
        ctx.translate(cx, cy);
        ctx.rotate((Math.sin(animPhase * 2.2 + baseSeed) * 0.028 + 0.02) * (1 - foldProgress));
        ctx.translate(-cx, -cy);

        drawRoundedRect(rectX, rectY, rectW, rectH, rectRadius);
        const cardGradient = ctx.createLinearGradient(rectX, rectY, rectX + rectW, rectY + rectH);
        cardGradient.addColorStop(0, 'rgba(248,251,255,0.98)');
        cardGradient.addColorStop(1, 'rgba(223,231,243,0.94)');
        ctx.fillStyle = cardGradient;
        ctx.fill();

        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(110,130,156,0.26)';
        ctx.stroke();

        ctx.fillStyle = 'rgba(44,58,82,0.48)';
        ctx.font = "600 11px 'Montserrat', 'Segoe UI', sans-serif";
        ctx.textBaseline = 'top';
        const titleLine = (card.title || card.id || '').slice(0, 24);
        if (titleLine) ctx.fillText(titleLine, rectX + 14, rectY + 14);

        ctx.fillStyle = 'rgba(63,78,103,0.34)';
        ctx.font = "500 10px 'Montserrat', 'Segoe UI', sans-serif";
        const previewLine = contentPreview.slice(0, 34);
        if (previewLine) ctx.fillText(previewLine, rectX + 14, rectY + 32);

        const foldCount = lowPower ? 3 : 4;
        for (let i = 0; i < foldCount; i += 1) {
          const k = (i + 1) / (foldCount + 1);
          const y = rectY + rectH * k;
          const curve = Math.sin(animPhase * 2.8 + k * 6 + baseSeed * 3) * (1.5 + foldProgress * 2.8);
          ctx.strokeStyle = `rgba(86,102,132,${0.12 + foldProgress * 0.08})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(rectX + 10, y);
          ctx.quadraticCurveTo(cx, y + curve, rectX + rectW - 10, y + curve * 0.4);
          ctx.stroke();
        }

        ctx.restore();
      }

      if (ballAlpha > 0.01) {
        const baseRadius = Math.min(width, height) * (0.16 + foldProgress * 0.14);

        ctx.save();
        ctx.globalAlpha = ballAlpha;
        ctx.translate(cx, cy);
        ctx.rotate(Math.sin(animPhase * 1.9 + baseSeed * Math.PI) * 0.08);

        ctx.beginPath();
        for (let i = 0; i < ringCount; i += 1) {
          const ratio = i / ringCount;
          const angle = ratio * Math.PI * 2;
          const noise = ringNoise[i];
          const wobble = Math.sin(animPhase * noise.freq + noise.phase) * noise.amp;
          const fine = Math.sin(animPhase * (noise.freq * 2.4) + noise.phase * 1.2) * (noise.amp * 0.45);
          const r = baseRadius * (1 + wobble + fine);
          const px = Math.cos(angle) * r;
          const py = Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();

        const bodyGradient = ctx.createRadialGradient(
          -baseRadius * 0.35,
          -baseRadius * 0.4,
          baseRadius * 0.2,
          baseRadius * 0.22,
          baseRadius * 0.18,
          baseRadius * 1.25
        );
        bodyGradient.addColorStop(0, 'rgba(255,255,255,0.98)');
        bodyGradient.addColorStop(0.48, 'rgba(226,233,242,0.96)');
        bodyGradient.addColorStop(1, 'rgba(179,191,207,0.94)');
        ctx.fillStyle = bodyGradient;
        ctx.fill();

        ctx.lineWidth = 1.1;
        ctx.strokeStyle = 'rgba(98,116,145,0.46)';
        ctx.stroke();

        ctx.strokeStyle = 'rgba(71,88,117,0.26)';
        ctx.lineWidth = 1;
        const creaseCount = lowPower ? 5 : 8;
        for (let i = 0; i < creaseCount; i += 1) {
          const ratio = i / creaseCount;
          const angle = ratio * Math.PI * 2 + Math.sin(animPhase * 1.7 + i) * 0.1;
          const inner = baseRadius * (0.12 + (i % 3) * 0.08);
          const outer = baseRadius * (0.7 + (i % 2) * 0.08);
          ctx.beginPath();
          ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
          ctx.quadraticCurveTo(
            Math.cos(angle + 0.2) * (baseRadius * 0.45),
            Math.sin(angle - 0.16) * (baseRadius * 0.46),
            Math.cos(angle) * outer,
            Math.sin(angle) * outer
          );
          ctx.stroke();
        }

        ctx.restore();
      }

      rafId = window.requestAnimationFrame(draw);
    };

    rafId = window.requestAnimationFrame(draw);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener('resize', resize);
    };
  }, [baseSeed, card.id, card.title, card.description, contentPreview, reducedMotion, lowPower]);

  return (
    <div className="paperCrumpleOverlay" style={{ height: overlayHeight }} aria-hidden="true">
      <canvas ref={canvasRef} className="paperCrumpleCanvas" />
    </div>
  );
}

function TrashGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path
        d="M3.85 6.35c0-.61.49-1.1 1.1-1.1h14.1c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1H4.95c-.61 0-1.1-.49-1.1-1.1Z"
        fill="currentColor"
      />
      <path
        d="M9 3.6c0-.44.36-.8.8-.8h4.4c.44 0 .8.36.8.8v1.65H9V3.6Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6.12 8.18h11.76l-1.12 10.96a1.38 1.38 0 0 1-1.37 1.24H8.61a1.38 1.38 0 0 1-1.37-1.24L6.12 8.18Zm2.85 2.1c.42 0 .76.34.76.76v6.25a.76.76 0 1 1-1.52 0v-6.25c0-.42.34-.76.76-.76Zm3.03 0c.42 0 .76.34.76.76v6.25a.76.76 0 1 1-1.52 0v-6.25c0-.42.34-.76.76-.76Zm3.03 0c.42 0 .76.34.76.76v6.25a.76.76 0 1 1-1.52 0v-6.25c0-.42.34-.76.76-.76Z"
        fill="currentColor"
      />
    </svg>
  );
}

function uid() {
  return crypto.randomUUID();
}

function nextCardId(cardsById: BoardState['cardsById']) {
  let max = 0;
  for (const rawId of Object.keys(cardsById)) {
    const m = /^P-(\d+)$/i.exec(rawId.trim());
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `P-${max + 1}`;
}

function formatCardId(id: string) {
  const normalized = String(id ?? '').trim();
  if (/^P-\d+$/i.test(normalized)) return normalized.toUpperCase();
  if (normalized.length <= 8) return normalized.toUpperCase();
  return `${normalized.slice(0, 6).toUpperCase()}…`;
}

function toFavoriteDragId(cardId: string): string {
  return `${FAVORITE_DND_PREFIX}${String(cardId ?? '').trim()}`;
}

function fromFavoriteDragId(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw.startsWith(FAVORITE_DND_PREFIX)) return null;
  const cardId = raw.slice(FAVORITE_DND_PREFIX.length).trim();
  return cardId || null;
}

function extractCardCreatorName(createdBy: string | null | undefined): string {
  const creator = String(createdBy ?? '').trim();
  return creator ? creator.slice(0, 64) : '';
}

function getChecklistProgress(card: Card): { total: number; done: number } {
  const checklist = Array.isArray(card.checklist) ? card.checklist : [];
  if (checklist.length === 0) return { total: 0, done: 0 };
  let done = 0;
  for (const item of checklist) {
    if (item?.done === true) done += 1;
  }
  return { total: checklist.length, done };
}

function renderSearchHighlight(text: string, query: string, pulse: number, keyPrefix: string): ReactNode {
  if (!query || pulse <= 0) return text;
  const source = text ?? '';
  if (!source) return source;

  const haystack = source.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return source;

  const parts: ReactNode[] = [];
  let cursor = 0;
  let hit = 0;

  while (cursor < source.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;

    if (found > cursor) parts.push(source.slice(cursor, found));
    const end = found + needle.length;
    parts.push(
      <mark key={`${keyPrefix}-${pulse}-${hit}-${found}`} className="searchHit searchHitPulse">
        {source.slice(found, end)}
      </mark>
    );
    cursor = end;
    hit += 1;
  }

  if (hit === 0) return source;
  if (cursor < source.length) parts.push(source.slice(cursor));
  return <>{parts}</>;
}

function compactSearchValue(value: string) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function clampFloatingPlacement(rect: { left: number; top: number; width: number; height: number }) {
  const maxX = Math.max(FLOATING_SIDE_PAD, window.innerWidth - rect.width - FLOATING_SIDE_PAD);
  const maxY = Math.max(FLOATING_TOP_PAD, window.innerHeight - rect.height - FLOATING_BOTTOM_PAD);
  return {
    x: Math.min(Math.max(Math.round(rect.left), FLOATING_SIDE_PAD), Math.round(maxX)),
    y: Math.min(Math.max(Math.round(rect.top), FLOATING_TOP_PAD), Math.round(maxY)),
  };
}

function estimateCardFootprint(columnId: ColumnId, card: Card): number {
  const titleLen = (card.title ?? '').trim().length;
  const descLen = richCommentToPlainText(card.description ?? '').length;

  const titleLines = Math.min(2, Math.max(1, Math.ceil(titleLen / 24)));
  const descLines = Math.min(4, Math.max(1, Math.ceil(descLen / 34)));

  const timerBonus = columnId === 'doing' ? 8 : 0;
  const pinBonus = columnId === 'queue' ? 4 : 0;

  // Includes card body + avg column gap to keep scroll math stable.
  const estimate = 86 + titleLines * 12 + descLines * 13 + timerBonus + pinBonus + 14;
  return clampColumnVirtualRowEstimate(estimate);
}

function boardFingerprint(state: BoardState) {
  const cardIds = Object.keys(state.cardsById).sort();
  const cards = cardIds.map((id) => {
    const c = state.cardsById[id];
    const cardImages = Array.isArray(c.images)
      ? c.images.map((img) => [
          img.id,
          img.dataUrl,
          img.mime,
          img.size,
          img.name,
          img.createdAt,
          img.fileId ?? null,
          img.previewFileId ?? null,
          img.previewUrl ?? null,
          img.previewMime ?? null,
          img.previewSize ?? null,
        ])
      : [];
    const comments = Array.isArray(c.comments)
      ? c.comments.map((comment) => [
          comment.id,
          comment.text,
          comment.createdAt,
          comment.updatedAt ?? null,
          comment.author ?? null,
          Array.isArray(comment.images)
            ? comment.images.map((img) => [
                img.id,
                img.dataUrl,
                img.mime,
                img.size,
                img.name,
                img.createdAt,
                img.fileId ?? null,
                img.previewFileId ?? null,
                img.previewUrl ?? null,
                img.previewMime ?? null,
                img.previewSize ?? null,
              ])
            : [],
        ])
      : [];
    const checklist = Array.isArray(c.checklist)
      ? c.checklist.map((item) => [item.id, item.text, item.done ? 1 : 0, item.createdAt])
      : [];
    return [
      id,
      c.title,
      c.description,
      c.createdBy ?? null,
      c.createdAt,
      c.urgency,
      c.isFavorite ? 1 : 0,
      cardImages,
      comments,
      checklist,
      c.doingStartedAt ?? null,
      c.doingTotalMs,
    ];
  });

  const floating = Object.keys(state.floatingById ?? {})
    .sort()
    .map((id) => {
      const pin = state.floatingById[id];
      return [id, Math.round(pin.x), Math.round(pin.y), Math.round(pin.swayOffsetMs ?? 0)];
    });

  const history = (state.history ?? []).map((h) => [
    h.id,
    h.at,
    h.text,
    h.cardId ?? null,
    h.kind ?? null,
    h.meta ?? null,
  ]);

  return JSON.stringify([
    cards,
    state.columns.queue,
    state.columns.doing,
    state.columns.review,
    state.columns.done,
    floating,
    history,
  ]);
}

function renderHistoryText(
  entry: HistoryEntry,
  t: (key: string, vars?: Record<string, string | number>) => string
) {
  const text = historyText(entry, t);
  const title = historyTitle(entry, t('common.untitled'));
  if (!title) return text;

  const marker = `"${title}"`;
  const idx = text.indexOf(marker);
  if (idx < 0) return text;

  const left = text.slice(0, idx);
  const right = text.slice(idx + marker.length);

  return (
    <>
      <span>{left}"</span>
      <span className="historyCardTitle">{title}</span>
      <span>"{right}</span>
    </>
  );
}

function DroppableColumnBody({
  id,
  children,
  className,
  bodyRef,
}: {
  id: ColumnId;
  children: React.ReactNode;
  className?: string;
  bodyRef?: { current: HTMLDivElement | null };
}) {
  const { setNodeRef } = useDroppable({ id });
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (bodyRef) bodyRef.current = node;
    },
    [setNodeRef, bodyRef]
  );

  return (
    <div ref={setRefs} className={className ? `colBody ${className}` : 'colBody'}>
      {children}
    </div>
  );
}

function TrashZone({
  active,
  t,
}: {
  active: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'trash' });

  return (
    <div
      ref={setNodeRef}
      className={`trashLite ${active ? 'trashLiteShown' : 'trashLiteHidden'} ${isOver ? 'trashLiteOver' : ''}`}
      title={t('trash.title')}
      aria-label={t('trash.aria')}
      aria-hidden={!active}
    >
      <div className="trashLiteIcon" aria-hidden="true">
        <TrashGlyph className="trashGlyph trashGlyphZone" />
      </div>
    </div>
  );
}

function FloatingCanvasDropZone() {
  const { setNodeRef } = useDroppable({ id: FREE_CANVAS_DROPPABLE_ID });

  return <div ref={setNodeRef} className="floatingCanvasDropZone" aria-hidden="true" />;
}

function FloatingCard({
  card,
  x,
  y,
  swayOffsetMs,
  searchQuery,
  highlightPulse,
  uncrumpleToken,
  t,
  onOpen,
}: {
  card: Card;
  x: number;
  y: number;
  swayOffsetMs: number;
  searchQuery: string;
  highlightPulse: number;
  uncrumpleToken: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpen: (cardId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    data: { type: 'card', source: 'floating' },
  });

  const dragTransform = transform
    ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
    : undefined;
  const swayPhaseMs = Math.max(0, Math.round(swayOffsetMs));
  const swayDelaySec = -((swayPhaseMs % 3800) / 1000);
  const nailTone = useMemo(() => nailToneFromSwayOffset(swayOffsetMs), [swayOffsetMs]);

  const handleClick = useCallback(() => {
    if (isDragging) return;
    onOpen(card.id);
  }, [isDragging, onOpen, card.id]);

  const cardIdLabel = useMemo(() => formatCardId(card.id), [card.id]);
  const titleText = useMemo(() => card.title || t('common.untitled'), [card.title, t]);
  const plainDescText = useMemo(() => richCommentToPlainText(card.description || '') || '—', [card.description]);
  const creatorText = useMemo(
    () => extractCardCreatorName(card.createdBy) || t('card.creator.unknown'),
    [card.createdBy, t]
  );
  const commentsCount = Array.isArray(card.comments) ? card.comments.length : 0;
  const checklistProgress = useMemo(() => getChecklistProgress(card), [card]);
  const highlightedId = useMemo(
    () => renderSearchHighlight(cardIdLabel, searchQuery, highlightPulse, `float-id-${card.id}`),
    [cardIdLabel, searchQuery, highlightPulse, card.id]
  );
  const highlightedCreator = useMemo(
    () => renderSearchHighlight(creatorText, searchQuery, highlightPulse, `float-creator-${card.id}`),
    [creatorText, searchQuery, highlightPulse, card.id]
  );
  const highlightedTitle = useMemo(
    () => renderSearchHighlight(titleText, searchQuery, highlightPulse, `float-title-${card.id}`),
    [titleText, searchQuery, highlightPulse, card.id]
  );
  const highlightedDesc = useMemo(
    () => renderSearchHighlight(plainDescText, searchQuery, highlightPulse, `float-desc-${card.id}`),
    [plainDescText, searchQuery, highlightPulse, card.id]
  );

  return (
    <div
      ref={setNodeRef}
      className={`floatingCardShell ${isDragging ? 'isDragging' : ''}`}
      data-nail-tone={nailTone}
      style={{
        left: `${Math.round(x)}px`,
        top: `${Math.max(FLOATING_TOP_PAD, Math.round(y))}px`,
        transform: dragTransform,
      }}
      {...attributes}
      {...listeners}
      onClick={handleClick}
    >
      <span className="floatingHangNailStandalone" aria-hidden="true">
        <span className="floatingHangNailHead" />
        <span className="floatingHangNailBody" />
        <span className="floatingHangNailBase" />
        <span className="floatingHangNailNeedle" />
      </span>
      <motion.div
        className="floatingCardRig"
        animate={isDragging ? { rotate: 0 } : { rotate: [-3.2, 3.2, -3.2] }}
        transition={
          isDragging
            ? { duration: 0.12 }
            : { duration: 3.8, ease: 'easeInOut', repeat: Infinity, repeatType: 'mirror', delay: swayDelaySec }
        }
      >
        <div className="floatingHangRopesStandalone" aria-hidden="true">
          <span className="floatingHangRopeStandalone floatingHangRopeStandaloneLeft" />
          <span className="floatingHangRopeStandalone floatingHangRopeStandaloneRight" />
        </div>
        <div
          className={`card floatingCard ${card.isFavorite ? 'isFavoriteCard' : ''} ${uncrumpleToken ? 'cardUncrumple' : ''}`}
          data-card-id={card.id}
          data-u={card.urgency}
        >
          <div className="floatingHangDecor" aria-hidden="true">
            <span className="floatingHangAnchor floatingHangAnchorLeft" />
            <span className="floatingHangAnchor floatingHangAnchorRight" />
          </div>
          <div className="urgBar" />
          <div className="cardMeta">
            <span className="cardId" title={t('card.id.title', { id: card.id })}>
              {highlightedId}
            </span>
            {commentsCount > 0 ? (
              <span
                key={`comments-float-${card.id}-${commentsCount}`}
                className="cardComments cardCommentsPulse"
                title={t('card.comments.title', { count: commentsCount })}
                aria-label={t('card.comments.title', { count: commentsCount })}
              >
                <CommentsGlyph className="cardCommentsIcon" />
                <span className="cardCommentsText">{commentsCount}</span>
              </span>
            ) : null}
            {checklistProgress.total > 0 ? (
              <span
                className={`cardChecklist ${checklistProgress.done === checklistProgress.total ? 'isComplete' : ''}`}
                title={t('card.checklist.title', { done: checklistProgress.done, total: checklistProgress.total })}
                aria-label={t('card.checklist.title', { done: checklistProgress.done, total: checklistProgress.total })}
              >
                <ChecklistGlyph className="cardChecklistIcon" />
                <span className="cardChecklistText">{`${checklistProgress.done}/${checklistProgress.total}`}</span>
              </span>
            ) : null}
          </div>
          <p className="cardCreator" title={t('card.creator.title', { name: creatorText })}>
            {highlightedCreator}
          </p>
          <p className="cardTitle">{highlightedTitle}</p>
          <p className="cardDesc">{highlightedDesc}</p>
        </div>
      </motion.div>
    </div>
  );
}

function FavoriteSortableCard({
  card,
  status,
  searchQuery,
  highlightPulse,
  onOpen,
  onToggleFavorite,
  t,
}: {
  card: Card;
  status: ColumnId | 'freedom';
  searchQuery: string;
  highlightPulse: number;
  onOpen: (cardId: string) => void;
  onToggleFavorite: (cardId: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: toFavoriteDragId(card.id),
    data: { type: 'favorite-card', cardId: card.id },
  });

  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : 1,
    visibility: isDragging ? 'hidden' : 'visible',
    pointerEvents: isDragging ? 'none' : undefined,
  };

  const handleOpen = useCallback(() => {
    if (isDragging) return;
    onOpen(card.id);
  }, [isDragging, onOpen, card.id]);

  const handleToggleFavorite = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onToggleFavorite(card.id);
    },
    [card.id, onToggleFavorite]
  );

  const cardIdLabel = useMemo(() => formatCardId(card.id), [card.id]);
  const creatorText = useMemo(
    () => extractCardCreatorName(card.createdBy) || t('card.creator.unknown'),
    [card.createdBy, t]
  );
  const titleText = useMemo(() => card.title || t('common.untitled'), [card.title, t]);
  const descText = useMemo(() => richCommentToPlainText(card.description || '') || '—', [card.description]);

  const highlightedId = useMemo(
    () => renderSearchHighlight(cardIdLabel, searchQuery, highlightPulse, `fav-id-${card.id}`),
    [cardIdLabel, searchQuery, highlightPulse, card.id]
  );
  const highlightedCreator = useMemo(
    () => renderSearchHighlight(creatorText, searchQuery, highlightPulse, `fav-creator-${card.id}`),
    [creatorText, searchQuery, highlightPulse, card.id]
  );
  const highlightedTitle = useMemo(
    () => renderSearchHighlight(titleText, searchQuery, highlightPulse, `fav-title-${card.id}`),
    [titleText, searchQuery, highlightPulse, card.id]
  );
  const highlightedDesc = useMemo(
    () => renderSearchHighlight(descText, searchQuery, highlightPulse, `fav-desc-${card.id}`),
    [descText, searchQuery, highlightPulse, card.id]
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`favoritesCard ${isDragging ? 'isDragging' : ''}`}
      data-u={card.urgency}
      onClick={handleOpen}
      title={t('card.id.title', { id: card.id })}
      aria-label={t('board.cardOpen')}
      {...attributes}
      {...listeners}
    >
      <div className="urgBar" />
      <div className="favoritesCardMeta">
        <span className="cardId">{highlightedId}</span>
        <span className="favoritesCardStatus">{t(FAVORITE_STATUS_LABEL_KEY[status])}</span>
        <button
          type="button"
          className="favoritesCardStar"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onClick={handleToggleFavorite}
          title={card.isFavorite ? t('card.favorite.remove') : t('card.favorite.add')}
          aria-label={card.isFavorite ? t('card.favorite.remove') : t('card.favorite.add')}
        >
          <StarGlyph className="favoriteGlyph" />
        </button>
      </div>
      <p className="cardCreator" title={t('card.creator.title', { name: creatorText })}>
        {highlightedCreator}
      </p>
      <p className="cardTitle">{highlightedTitle}</p>
      <p className="cardDesc">{highlightedDesc}</p>
    </div>
  );
}

type ColumnConfig = (typeof columns)[number];

const BoardColumn = memo(function BoardColumn({
  column,
  allIds,
  visIds,
  cards,
  isFiltering,
  nowTick,
  activeDoingIds,
  searchQuery,
  highlightPulse,
  uncrumpleTokensById,
  dragActive,
  t,
  onOpen,
}: {
  column: ColumnConfig;
  allIds: string[];
  visIds: string[];
  cards: Card[];
  isFiltering: boolean;
  nowTick: number;
  activeDoingIds: Set<string>;
  searchQuery: string;
  highlightPulse: number;
  uncrumpleTokensById: Record<string, number>;
  dragActive: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpen: (cardId: string) => void;
}) {
  const badgeText = isFiltering ? `${visIds.length}/${allIds.length}` : String(allIds.length);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const rowEstimate = useMemo(() => {
    const base = column.id === 'doing' ? 128 : 120;
    if (cards.length === 0) return base;

    const sample = cards.slice(0, 20);
    const total = sample.reduce((sum, c) => sum + estimateCardFootprint(column.id, c), 0);
    const avg = Math.round(total / sample.length);
    return clampColumnVirtualRowEstimate(avg);
  }, [cards, column.id]);
  const canVirtualize = !dragActive && !isFiltering && cards.length >= BOARD_PERF.columnVirtualization.threshold;

  useEffect(() => {
    if (!canVirtualize) return;
    const node = bodyRef.current;
    if (!node) return;

    const sync = () => {
      setScrollTop(node.scrollTop);
      setViewportHeight(node.clientHeight);
    };
    sync();

    const onScroll = () => setScrollTop(node.scrollTop);
    node.addEventListener('scroll', onScroll, { passive: true });

    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => setViewportHeight(node.clientHeight);
      window.addEventListener('resize', onResize);
      return () => {
        node.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
      };
    }

    const ro = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    ro.observe(node);
    return () => {
      node.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, [canVirtualize, cards.length]);

  const { renderCards, sortableItems, topSpacer, bottomSpacer } = useMemo(() => {
    if (!canVirtualize) {
      return {
        renderCards: cards,
        sortableItems: visIds,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }

    const view = Math.max(viewportHeight, rowEstimate);
    const start = Math.max(0, Math.floor(scrollTop / rowEstimate) - BOARD_PERF.columnVirtualization.overscan);
    const end = Math.min(cards.length, Math.ceil((scrollTop + view) / rowEstimate) + BOARD_PERF.columnVirtualization.overscan);

    return {
      renderCards: cards.slice(start, end),
      sortableItems: cards.slice(start, end).map((c) => c.id),
      topSpacer: start * rowEstimate,
      bottomSpacer: Math.max(0, (cards.length - end) * rowEstimate),
    };
  }, [canVirtualize, cards, visIds, scrollTop, viewportHeight, rowEstimate]);

  const bodyClassName = [
    canVirtualize ? 'colBodyVirtualized' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={`col col_${column.id}`}>
      <div className={`colHead ${column.accent}`}>
        <p className="colTitle">{t(COLUMN_TITLE_KEY[column.id])}</p>
        <span className="badge">{badgeText}</span>
      </div>

      <DroppableColumnBody
        id={column.id}
        bodyRef={bodyRef}
        className={bodyClassName || undefined}
      >
        <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
          {cards.length === 0 ? (
            <div className={`empty ${isFiltering ? 'emptyFiltered' : ''}`}>
              <span className="emptyTitle">{isFiltering ? t('empty.filtered') : t(EMPTY_COLUMN_TEXT_KEY[column.id])}</span>
            </div>
          ) : (
            <>
              {canVirtualize && topSpacer > 0 ? <div className="virtualSpacer" style={{ height: topSpacer }} /> : null}
              {renderCards.map((c) => (
                <SortableCard
                  key={c.id}
                  card={c}
                  columnId={column.id}
                  now={column.id === 'doing' && activeDoingIds.has(c.id) ? nowTick : undefined}
                  searchQuery={searchQuery}
                  highlightPulse={highlightPulse}
                  uncrumpleToken={uncrumpleTokensById[c.id] ?? 0}
                  onOpen={onOpen}
                />
              ))}
              {canVirtualize && bottomSpacer > 0 ? (
                <div className="virtualSpacer" style={{ height: bottomSpacer }} />
              ) : null}
            </>
          )}
        </SortableContext>
      </DroppableColumnBody>
    </div>
  );
});

const HistoryPanel = memo(function HistoryPanel({
  items,
  existingCardIds,
  nowTs,
  locale,
  t,
  onClear,
  onOpenCard,
}: {
  items: HistoryEntry[];
  existingCardIds: Set<string>;
  nowTs: number;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClear: () => void;
  onOpenCard: (cardId: string) => void;
}) {
  const motionProfile = useMotionProfile();
  const [historyFilter, setHistoryFilter] = useState<HistoryFilterKey>('all');
  const [historyFiltersVisible, setHistoryFiltersVisible] = useState(false);
  const [historyFilterOpen, setHistoryFilterOpen] = useState(false);
  const historyFilterDropdownOpen = historyFiltersVisible && historyFilterOpen;
  const [visibleCount, setVisibleCount] = useState<number>(BOARD_PERF.history.pageSize);
  const historyFilterRef = useRef<HTMLDivElement | null>(null);
  const historyListRef = useRef<HTMLDivElement | null>(null);
  const [historyVirtualHeights, setHistoryVirtualHeights] = useState<Record<string, number>>({});
  const [historyScrollTop, setHistoryScrollTop] = useState(0);
  const [historyViewportHeight, setHistoryViewportHeight] = useState(0);
  const historyScrollRafRef = useRef<number | null>(null);
  const pendingHistoryScrollTopRef = useRef(0);

  const activeHistoryFilter = useMemo(
    () => HISTORY_FILTERS.find((f) => f.key === historyFilter) ?? HISTORY_FILTERS[0],
    [historyFilter]
  );

  const filteredItems = useMemo(() => {
    if (historyFilter === 'all') return items;
    return items.filter((h) => historyKind(h) === historyFilter);
  }, [items, historyFilter]);

  const limitedItems = useMemo(() => filteredItems.slice(0, visibleCount), [filteredItems, visibleCount]);
  const canShowMore = filteredItems.length > limitedItems.length;

  const grouped = useMemo(() => {
    const rows: Array<{ label: string; items: HistoryEntry[] }> = [];

    for (const h of limitedItems) {
      const label = historyDayLabel(h.at, nowTs, locale, t);
      const prev = rows[rows.length - 1];
      if (!prev || prev.label !== label) {
        rows.push({ label, items: [h] });
      } else {
        prev.items.push(h);
      }
    }

    return rows;
  }, [limitedItems, nowTs, locale, t]);

  const historyVirtualizeThreshold = useMemo(() => {
    return resolveHistoryVirtualizeThreshold(historyViewportHeight, motionProfile.isMobile);
  }, [historyViewportHeight, motionProfile.isMobile]);

  const shouldVirtualizeHistory = limitedItems.length >= historyVirtualizeThreshold;
  const historyVirtualRows = useMemo<HistoryVirtualRow[]>(() => {
    const rows: HistoryVirtualRow[] = [];
    grouped.forEach((group, groupIndex) => {
      rows.push({
        kind: 'group',
        key: `group-${groupIndex}-${group.label}`,
        label: group.label,
      });
      group.items.forEach((entry) => {
        rows.push({
          kind: 'item',
          key: `item-${entry.id}`,
          entry,
        });
      });
    });
    return rows;
  }, [grouped]);

  const historyVirtualMetrics = useMemo(() => {
    if (!shouldVirtualizeHistory || historyVirtualRows.length === 0) return null;
    const offsets = new Array(historyVirtualRows.length + 1);
    offsets[0] = 0;

    for (let i = 0; i < historyVirtualRows.length; i += 1) {
      const row = historyVirtualRows[i];
      const estimated =
        row.kind === 'group' ? BOARD_PERF.history.virtualization.groupRowEstimate : BOARD_PERF.history.virtualization.itemRowEstimate;
      const nextHeight = Math.max(estimated, historyVirtualHeights[row.key] ?? 0);
      offsets[i + 1] = offsets[i] + nextHeight;
    }

    const viewportTop = Math.max(0, historyScrollTop);
    const viewportBottom = viewportTop + Math.max(1, historyViewportHeight || 1);
    const firstVisible = findVirtualOffsetIndex(offsets, viewportTop);
    const lastVisible = findVirtualOffsetIndex(offsets, viewportBottom);
    const startIndex = Math.max(0, firstVisible - BOARD_PERF.history.virtualization.overscan);
    const endIndex = Math.min(historyVirtualRows.length - 1, lastVisible + BOARD_PERF.history.virtualization.overscan);
    const topSpacer = offsets[startIndex];
    const bottomSpacer = Math.max(0, offsets[offsets.length - 1] - offsets[endIndex + 1]);

    return {
      rows: historyVirtualRows.slice(startIndex, endIndex + 1),
      topSpacer,
      bottomSpacer,
    };
  }, [
    historyVirtualHeights,
    historyScrollTop,
    historyViewportHeight,
    historyVirtualRows,
    shouldVirtualizeHistory,
  ]);

  const measureHistoryRow = useCallback((rowKey: string, node: HTMLDivElement | null) => {
    if (!node) return;
    const nextHeight = Math.ceil(node.getBoundingClientRect().height);
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
    setHistoryVirtualHeights((prev) => {
      const prevHeight = prev[rowKey] ?? 0;
      if (prevHeight === nextHeight) return prev;
      return { ...prev, [rowKey]: nextHeight };
    });
  }, []);

  const handleHistoryScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const nextTopRaw = Number(event.currentTarget.scrollTop || 0);
    const nextTop = Number.isFinite(nextTopRaw) ? nextTopRaw : 0;
    pendingHistoryScrollTopRef.current = nextTop;
    if (historyScrollRafRef.current != null) return;
    historyScrollRafRef.current = window.requestAnimationFrame(() => {
      historyScrollRafRef.current = null;
      const committedTop = pendingHistoryScrollTopRef.current;
      setHistoryScrollTop((prev) => (prev === committedTop ? prev : committedTop));
    });
  }, []);

  useEffect(() => {
    if (!historyFilterDropdownOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = historyFilterRef.current;
      if (!root) return;
      const targetNode = event.target as Node | null;
      if (!targetNode) return;
      if (root.contains(targetNode)) return;
      setHistoryFilterOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHistoryFilterOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [historyFilterDropdownOpen]);

  useEffect(() => {
    const node = historyListRef.current;
    if (!node) return;

    const syncMetrics = () => {
      setHistoryViewportHeight(node.clientHeight || 0);
      setHistoryScrollTop(node.scrollTop || 0);
    };

    syncMetrics();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => syncMetrics());
    observer.observe(node);
    return () => observer.disconnect();
  }, [historyFiltersVisible, limitedItems.length, shouldVirtualizeHistory]);

  useEffect(() => {
    return () => {
      if (historyScrollRafRef.current != null) {
        window.cancelAnimationFrame(historyScrollRafRef.current);
        historyScrollRafRef.current = null;
      }
    };
  }, []);

  const renderHistoryItem = useCallback(
    (entry: HistoryEntry) => {
      const canOpen = !!(entry.cardId && existingCardIds.has(entry.cardId));
      if (!canOpen) {
        return (
          <div className="historyItem historyItemDisabled">
            <div className="historyTime">{formatDateTime(entry.at, locale)}</div>
            <div className="historyText">{renderHistoryText(entry, t)}</div>
          </div>
        );
      }

      return (
        <button
          type="button"
          className="historyItem historyItemBtn"
          onClick={() => onOpenCard(entry.cardId!)}
          title={t('board.cardOpen')}
        >
          <div className="historyTime">{formatDateTime(entry.at, locale)}</div>
          <div className="historyText">{renderHistoryText(entry, t)}</div>
        </button>
      );
    },
    [existingCardIds, locale, onOpenCard, t]
  );

  const isHistoryEmpty = limitedItems.length === 0;

  return (
    <div className={`panel historyPanel ${historyFiltersVisible ? 'historyPanelFiltersOpen' : ''} ${isHistoryEmpty ? 'historyPanelEmpty' : ''}`}>
      <div className="panelHead">
        <div className="historyHeadMain">
          <div className="panelTitle">{t('history.title')}</div>
          <button
            type="button"
            className={`panelIconBtn historyFilterToggleBtn ${historyFiltersVisible ? 'isOpen' : ''}`}
            title={historyFiltersVisible ? t('board.filter.hide') : t('board.filter.show')}
            aria-label={historyFiltersVisible ? t('board.filter.hide') : t('board.filter.show')}
            aria-expanded={historyFiltersVisible}
            aria-controls="history-toolbar"
            onClick={() => {
              setHistoryFiltersVisible((prev) => {
                const next = !prev;
                if (!next) setHistoryFilterOpen(false);
                return next;
              });
            }}
          >
            <FilterGlyph className="historyFilterToggleIcon" />
          </button>
        </div>

        <button
          className="panelIconBtn"
          title={t('history.clear')}
          aria-label={t('history.clear')}
          onClick={onClear}
          disabled={items.length === 0}
        >
          <TrashGlyph className="trashGlyph trashGlyphSmall" />
        </button>
      </div>

      <AnimatePresence initial={false} mode="wait">
        {historyFiltersVisible ? (
          <motion.div
            key="history-toolbar-motion"
            className="historyToolbarMotion"
            initial={{ height: 0, opacity: 0, x: motionProfile.searchSlideX * 0.65, scale: motionProfile.searchScaleFrom }}
            animate={{ height: 'auto', opacity: 1, x: 0, scale: 1 }}
            exit={{ height: 0, opacity: 0, x: motionProfile.searchSlideX * 0.65, scale: motionProfile.searchScaleFrom }}
            transition={{
              height: motionProfile.controlLayoutTransition,
              opacity: motionProfile.controlFadeTransition,
              x: motionProfile.controlLayoutTransition,
              scale: motionProfile.controlLayoutTransition,
            }}
            style={{ overflow: historyFilterDropdownOpen ? 'visible' : 'hidden' }}
          >
            <div id="history-toolbar" className="historyToolbar">
              <div className="historyFilterLabel" id="history-filter-label">
                {t('history.filter.aria')}
              </div>
              <div className={`historyFilterSelectWrap ${historyFilterDropdownOpen ? 'isOpen' : ''}`} ref={historyFilterRef}>
                <button
                  type="button"
                  id="history-filter-select"
                  className="historyFilterSelect historyFilterSelectBtn"
                  aria-haspopup="listbox"
                  aria-expanded={historyFilterDropdownOpen}
                  aria-labelledby="history-filter-label history-filter-select"
                  onClick={() => {
                    setHistoryFilterOpen((prev) => !prev);
                  }}
                >
                  <span className="historyFilterSelectValue">{t(activeHistoryFilter.labelKey)}</span>
                </button>
                <AnimatePresence initial={false}>
                  {historyFilterDropdownOpen ? (
                    <motion.div
                      className="historyFilterMenu"
                      role="listbox"
                      aria-labelledby="history-filter-label"
                      initial={{ opacity: 0, y: -5, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -5, scale: 0.98 }}
                      transition={motionProfile.controlLayoutTransition}
                    >
                      {HISTORY_FILTERS.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          role="option"
                          aria-selected={historyFilter === f.key}
                          className={`historyFilterOption ${historyFilter === f.key ? 'historyFilterOptionActive' : ''}`}
                          onClick={() => {
                            setHistoryFilter(f.key);
                            setVisibleCount(BOARD_PERF.history.pageSize);
                            setHistoryFilterOpen(false);
                          }}
                        >
                          {t(f.labelKey)}
                        </button>
                      ))}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div
        className="historyList"
        ref={historyListRef}
        onScroll={shouldVirtualizeHistory ? handleHistoryScroll : undefined}
      >
        {limitedItems.length === 0 ? (
          <div className="historyEmpty">
            {items.length === 0
              ? t('history.empty')
              : t('history.empty.filtered')}
          </div>
        ) : (
          shouldVirtualizeHistory && historyVirtualMetrics ? (
            <div className="historyVirtualList">
              {historyVirtualMetrics.topSpacer > 0 ? (
                <div className="virtualSpacer" style={{ height: historyVirtualMetrics.topSpacer }} />
              ) : null}
              {historyVirtualMetrics.rows.map((row) =>
                row.kind === 'group' ? (
                  <div
                    key={row.key}
                    ref={(node) => {
                      measureHistoryRow(row.key, node);
                    }}
                    className="historyVirtualGroupRow"
                  >
                    <div className="historyGroupTitle historyGroupTitleVirtual">{row.label}</div>
                  </div>
                ) : (
                  <div
                    key={row.key}
                    ref={(node) => {
                      measureHistoryRow(row.key, node);
                    }}
                    className="historyVirtualItemRow"
                  >
                    {renderHistoryItem(row.entry)}
                  </div>
                )
              )}
              {historyVirtualMetrics.bottomSpacer > 0 ? (
                <div className="virtualSpacer" style={{ height: historyVirtualMetrics.bottomSpacer }} />
              ) : null}
            </div>
          ) : (
            grouped.map((group) => (
              <section className="historyGroup" key={group.label}>
                <div className="historyGroupTitle">{group.label}</div>
                {group.items.map((entry) => (
                  <div key={entry.id}>{renderHistoryItem(entry)}</div>
                ))}
              </section>
            ))
          )
        )}

        {canShowMore ? (
          <button
            type="button"
            className="historyMoreBtn"
            onClick={() => setVisibleCount((prev) => prev + BOARD_PERF.history.pageSize)}
          >
            {t('history.more', { count: Math.min(BOARD_PERF.history.pageSize, filteredItems.length - limitedItems.length) })}
          </button>
        ) : null}
      </div>
    </div>
  );
});

type BoardProps = {
  sessionUser?: AuthUser | null;
  onLogout?: () => void | Promise<void>;
  onProfileSave?: (payload: ProfileUpdatePayload) => Promise<AuthUser>;
};

export function Board({ sessionUser, onLogout, onProfileSave }: BoardProps) {
  const { t, locale } = useI18n();
  const motionProfile = useMotionProfile();
  const [board, dispatch] = useReducer(boardReducer, undefined as unknown as BoardState, () => loadState());
  const sessionLogin = useMemo(() => {
    const raw = String(sessionUser?.login ?? '').trim();
    return raw || undefined;
  }, [sessionUser?.login]);
  const sessionAvatarUrl = useMemo(() => {
    const raw = String(sessionUser?.avatarUrl ?? '').trim();
    return raw || null;
  }, [sessionUser?.avatarUrl]);
  const sessionAvatarFallback = useMemo(() => {
    const source = sessionLogin ?? '';
    const first = source.trim().charAt(0);
    return first ? first.toUpperCase() : '?';
  }, [sessionLogin]);
  const canOpenProfileModal = Boolean(sessionLogin && (onLogout || onProfileSave));

  // ? debounced persist
  useDebouncedPersist(board, 350);
  const boardSigRef = useRef(boardFingerprint(board));
  const lastBoardMutationAtRef = useRef(Date.now());
  const syncInFlightRef = useRef(false);

  // UI состояния
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [createModalLoaded, setCreateModalLoaded] = useState(false);
  const [editModalLoaded, setEditModalLoaded] = useState(false);
  const [profileModalLoaded, setProfileModalLoaded] = useState(false);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);

  // Drag
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [uncrumpleTokensById, setUncrumpleTokensById] = useState<Record<string, number>>({});
  const uncrumpleTimersRef = useRef<Record<string, number>>({});
  const clearDragRafRef = useRef<number | null>(null);
  const dragMeasureRafRef = useRef<number | null>(null);
  const dragLayoutCacheRef = useRef<{
    activeId: string | null;
    byColumn: Partial<Record<ColumnId, { mids: number[]; scrollTop: number }>>;
  }>({ activeId: null, byColumn: {} });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } })
  );

  // Поиск + фильтр
  const [q, setQ] = useState('');
  const [urgFilter, setUrgFilter] = useState<UrgFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const filtersRef = useRef<HTMLDivElement | null>(null);
  const favoritesScrollerRef = useRef<HTMLDivElement | null>(null);
  const favoritesPanelRef = useRef<HTMLDivElement | null>(null);
  const favoriteOrderRef = useRef<string[]>([]);
  const [favoriteOrder, setFavoriteOrder] = useState<string[]>([]);
  const { setNodeRef: setFavoritesDropRef } = useDroppable({ id: FAVORITES_DROPPABLE_ID });

  // ? debounce поиска
  const qDebounced = useDebouncedValue(q, 200);
  const qNorm = qDebounced.trim().toLowerCase();
  const qCompact = compactSearchValue(qNorm);
  const createdTasksCount = useMemo(() => {
    return Object.keys(board.cardsById ?? {}).length;
  }, [board.cardsById]);
  const commentsTotalCount = useMemo(() => {
    const cards = Object.values(board.cardsById ?? {});
    let total = 0;
    for (const card of cards) total += Array.isArray(card.comments) ? card.comments.length : 0;
    return total;
  }, [board.cardsById]);

  const isFiltering = qNorm.length > 0 || urgFilter !== 'all';
  const [searchHighlightPulse, setSearchHighlightPulse] = useState(0);
  const [searchHighlightActive, setSearchHighlightActive] = useState(false);

  // Undo (UI-таймер)
  const [undo, setUndo] = useState<UndoPayload | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (createOpen) setCreateModalLoaded(true);
  }, [createOpen]);

  useEffect(() => {
    if (editOpen) setEditModalLoaded(true);
  }, [editOpen]);

  useEffect(() => {
    if (profileOpen) setProfileModalLoaded(true);
  }, [profileOpen]);

  useEffect(() => {
    if (!canOpenProfileModal) return;
    setProfileModalLoaded(true);
  }, [canOpenProfileModal]);


  useEffect(() => {
    boardSigRef.current = boardFingerprint(board);
    lastBoardMutationAtRef.current = Date.now();
  }, [board]);

  useEffect(() => {
    favoriteOrderRef.current = favoriteOrder;
  }, [favoriteOrder]);

  const clearUndo = useCallback(() => {
    if (undoTimerRef.current != null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndo(null);
  }, []);

  const startUndoTimer = useCallback(() => {
    if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => {
      setUndo(null);
      undoTimerRef.current = null;
    }, 5000);
  }, []);

  const undoDelete = useCallback(() => {
    if (!undo) return;
    const payload = undo;
    clearUndo();
    dispatch({ type: 'UNDO_RESTORE', now: Date.now(), payload, historyId: uid() });
  }, [undo, clearUndo]);

  const clearActiveDragSoon = useCallback(() => {
    if (clearDragRafRef.current != null) {
      window.cancelAnimationFrame(clearDragRafRef.current);
      clearDragRafRef.current = null;
    }
    clearDragRafRef.current = window.requestAnimationFrame(() => {
      clearDragRafRef.current = window.requestAnimationFrame(() => {
        setActiveDragId(null);
        clearDragRafRef.current = null;
      });
    });
  }, []);

  const cancelPendingDragMeasure = useCallback(() => {
    if (dragMeasureRafRef.current != null) {
      window.cancelAnimationFrame(dragMeasureRafRef.current);
      dragMeasureRafRef.current = null;
    }
  }, []);

  const triggerUncrumplePulse = useCallback(
    (cardId: string) => {
      const token = Date.now() + Math.floor(Math.random() * 997);
      setUncrumpleTokensById((prev) => ({ ...prev, [cardId]: token }));

      const prevTimer = uncrumpleTimersRef.current[cardId];
      if (prevTimer != null) window.clearTimeout(prevTimer);

      const clearDelay = motionProfile.reducedMotion ? 60 : 520;
      uncrumpleTimersRef.current[cardId] = window.setTimeout(() => {
        setUncrumpleTokensById((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev, cardId)) return prev;
          const next = { ...prev };
          delete next[cardId];
          return next;
        });
        delete uncrumpleTimersRef.current[cardId];
      }, clearDelay);
    },
    [motionProfile.reducedMotion]
  );

  useEffect(() => {
    return () => {
      const timers = Object.values(uncrumpleTimersRef.current);
      timers.forEach((timer) => window.clearTimeout(timer));
      uncrumpleTimersRef.current = {};
    };
  }, []);

  const activeDoingIds = useMemo(() => {
    const set = new Set<string>();
    for (const id of board.columns.doing) {
      if (board.cardsById[id]?.doingStartedAt != null) set.add(id);
    }
    return set;
  }, [board.columns.doing, board.cardsById]);

  const hasActiveDoing = activeDoingIds.size > 0;

  const cardColumnMap = useMemo(() => buildCardColumnMap(board.columns), [board.columns]);

  // ? умный тик времени
  const [nowTick, setNowTick] = useState(() => Date.now());

  const activeCardForTick = activeCardId ? board.cardsById[activeCardId] ?? null : null;
  const activeColForTick = activeCardId ? cardColumnMap.get(activeCardId) ?? null : null;

  const needsFastTick =
    editOpen &&
    activeColForTick === 'doing' &&
    !!activeCardForTick?.doingStartedAt; // быстро тикаем только если таймер реально запущен

  const needTick = hasActiveDoing || needsFastTick;

  useEffect(() => {
    if (!needTick) return;

    // На карточках "Делаем" показываем секунды, поэтому тикаем раз в секунду.
    const intervalMs = 1000;

    const syncNow = () => setNowTick(Date.now());

    if (!document.hidden) {
      // Выносим в async callback, чтобы не дергать setState синхронно в эффекте.
      window.setTimeout(syncNow, 0);
    }

    const t = window.setInterval(() => {
      if (document.hidden) return;
      syncNow();
    }, intervalMs);

    const onVis = () => {
      if (!document.hidden) syncNow();
    };

    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.clearInterval(t);
    };
  }, [needTick, needsFastTick]);

  useEffect(() => {
    if (searchOpen) window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const targetNode = event.target as Node | null;
      if (!targetNode) return;
      if (targetNode instanceof Element && targetNode.closest('.searchMorph')) return;
      if (targetNode instanceof Element && targetNode.closest('.filterMenuWrap')) return;
      if (targetNode instanceof Element && targetNode.closest('.favoritesToggleBtn')) return;
      if (targetNode instanceof Element && targetNode.closest('.favoritesSheetPanel')) return;
      if (q.trim().length === 0) setSearchOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setQ('');
      setSearchOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [searchOpen, q]);

  useEffect(() => {
    if (!qNorm) {
      setSearchHighlightActive(false);
      return;
    }

    setSearchHighlightPulse((prev) => prev + 1);
    setSearchHighlightActive(true);
    const timer = window.setTimeout(() => setSearchHighlightActive(false), 2600);
    return () => window.clearTimeout(timer);
  }, [qNorm]);

  useEffect(() => {
    let cancelled = false;
    let pollDelayMs = 2500;
    let unchangedStreak = 0;
    let errorStreak = 0;
    let timer: number | null = null;
    const localQuietMs = 900;
    const minDelayMs = 2500;
    const idleDelayMs = 5000;
    const maxIdleDelayMs = 10000;
    const maxErrorDelayMs = 15000;

    const scheduleNext = (delay = pollDelayMs) => {
      if (cancelled) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void tick();
      }, Math.max(200, Math.trunc(delay)));
    };

    const syncFromServer = async () => {
      if (cancelled || syncInFlightRef.current) return 'skipped' as const;
      if (activeDragId || createOpen || editOpen) return 'skipped' as const;
      if (Date.now() - lastBoardMutationAtRef.current < localQuietMs) return 'skipped' as const;

      syncInFlightRef.current = true;
      try {
        const remoteState = await loadRemoteBoard();
        if (!remoteState || cancelled) return 'unchanged' as const;

        const remoteSig = boardFingerprint(remoteState);
        if (remoteSig !== boardSigRef.current) {
          markStateAsRemoteSynced(remoteState);
          dispatch({ type: 'STATE_REPLACE', state: remoteState });
          return 'changed' as const;
        }
        return 'unchanged' as const;
      } catch {
        // Ignore transient sync errors; next tick will retry.
        return 'error' as const;
      } finally {
        syncInFlightRef.current = false;
      }
    };

    const tunePollDelay = (result: 'changed' | 'unchanged' | 'error' | 'skipped' | undefined) => {
      if (result === 'changed') {
        unchangedStreak = 0;
        errorStreak = 0;
        pollDelayMs = minDelayMs;
        return;
      }
      if (result === 'unchanged') {
        unchangedStreak += 1;
        errorStreak = 0;
        if (unchangedStreak >= 8) {
          pollDelayMs = maxIdleDelayMs;
        } else if (unchangedStreak >= 3) {
          pollDelayMs = idleDelayMs;
        } else {
          pollDelayMs = minDelayMs;
        }
        return;
      }
      if (result === 'error') {
        errorStreak += 1;
        unchangedStreak = 0;
        const nextDelay = minDelayMs * Math.pow(2, Math.min(errorStreak, 3));
        pollDelayMs = Math.min(maxErrorDelayMs, nextDelay);
        return;
      }
      // skipped
      unchangedStreak = 0;
      pollDelayMs = minDelayMs;
    };

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        scheduleNext(pollDelayMs);
        return;
      }
      const result = await syncFromServer();
      tunePollDelay(result);
      scheduleNext(pollDelayMs);
    };

    const onVisible = () => {
      if (document.hidden || cancelled) return;
      unchangedStreak = 0;
      errorStreak = 0;
      pollDelayMs = minDelayMs;
      scheduleNext(120);
    };

    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    scheduleNext(120);

    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [activeDragId, createOpen, editOpen]);

  useEffect(() => {
    if (!filtersOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = filtersRef.current;
      if (!root) return;
      const targetNode = event.target as Node | null;
      if (!targetNode) return;
      if (root.contains(targetNode)) return;
      if (targetNode instanceof Element && targetNode.closest('.searchMorph')) return;
      if (targetNode instanceof Element && targetNode.closest('.favoritesToggleBtn')) return;
      if (targetNode instanceof Element && targetNode.closest('.favoritesSheetPanel')) return;
      setFiltersOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [filtersOpen]);

  useEffect(() => {
    if (!favoritesOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const panel = favoritesPanelRef.current;
      const targetNode = event.target as Node | null;
      if (!targetNode) return;
      if (panel?.contains(targetNode)) return;
      if (targetNode instanceof Element && targetNode.closest('.favoritesToggleBtn')) return;
      if (targetNode instanceof Element && targetNode.closest('.searchMorph')) return;
      if (targetNode instanceof Element && targetNode.closest('.filterMenuWrap')) return;
      setFavoritesOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFavoritesOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [favoritesOpen]);

  useEffect(() => {
    if (!sessionLogin) {
      setProfileOpen(false);
    }
  }, [sessionLogin]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current != null) window.clearTimeout(undoTimerRef.current);
      if (clearDragRafRef.current != null) window.cancelAnimationFrame(clearDragRafRef.current);
      if (dragMeasureRafRef.current != null) window.cancelAnimationFrame(dragMeasureRafRef.current);
    };
  }, []);

  const existingCardIds = useMemo(() => new Set(Object.keys(board.cardsById)), [board.cardsById]);

  const activeCard: Card | null = activeCardId ? board.cardsById[activeCardId] ?? null : null;
  const activeCardColumn = activeCardId ? cardColumnMap.get(activeCardId) ?? null : null;
  const isReadOnly = activeCardColumn === 'done';

  // Таймер в модалке “Делаем”
  const showDoingTimer = activeCardColumn === 'doing';
  const doingMs = activeCard && showDoingTimer ? computeDoingMs(activeCard, nowTick) : 0;

  const openEdit = useCallback((id: string) => {
    setActiveCardId(id);
    setEditOpen(true);
  }, []);

  const closeEdit = useCallback(() => {
    setEditOpen(false);
    setActiveCardId(null);
  }, []);

  const openCreate = useCallback(() => {
    setCreateOpen(true);
  }, []);

  const createCard = useCallback((draft: { title: string; description: string; images: Card['images']; urgency: Urgency }) => {
    const cardId = nextCardId(board.cardsById);
    const createdBy = sessionLogin ? sessionLogin.trim() || null : null;
    dispatch({
      type: 'CARD_CREATE',
      now: Date.now(),
      cardId,
      title: draft.title,
      description: draft.description,
      images: draft.images,
      createdBy,
      urgency: draft.urgency,
      historyId: uid(),
    });
  }, [board.cardsById, sessionLogin]);

  const updateCard = useCallback(
    (id: string, patch: { title: string; description: string; images: Card['images'] }) => {
      dispatch({ type: 'CARD_UPDATE', cardId: id, patch });
      closeEdit();
    },
    [closeEdit]
  );

  const toggleCardFavorite = useCallback((id: string) => {
    const card = board.cardsById[id];
    if (!card) return;

    const nextIsFavorite = !card.isFavorite;
    dispatch({ type: 'CARD_TOGGLE_FAVORITE', cardId: id });

    if (!getAuthToken()) return;

    // Persist favorite immediately so browser close does not lose the toggle.
    void setRemoteCardFavorite(id, nextIsFavorite).catch(() => {
      // Keep optimistic UI; full-board sync will retry on next successful save cycle.
    });
  }, [board.cardsById]);

  const updateCardChecklist = useCallback((id: string, checklist: Card['checklist']) => {
    dispatch({ type: 'CARD_CHECKLIST_SET', cardId: id, checklist });

    if (!getAuthToken()) return;
    void setRemoteCardChecklist(id, checklist).catch(() => {
      // Keep optimistic UI; full-board sync will retry on next successful save cycle.
    });
  }, []);

  const changeCardStatus = useCallback(
    (id: string, toCol: ColumnId) => {
      const now = Date.now();
      const fromCol = findColumnOfCard(id, board.columns);
      const toIndex = board.columns[toCol].length;

      if (fromCol) {
        if (fromCol === toCol) return;
        dispatch({
          type: 'CARD_MOVE',
          now,
          cardId: id,
          toCol,
          toIndex,
          historyId: uid(),
        });
        return;
      }

      dispatch({
        type: 'CARD_DOCK',
        now,
        cardId: id,
        toCol,
        toIndex,
        historyId: uid(),
      });
    },
    [board.columns]
  );

  const addCardComment = useCallback(
    async (cardId: string, text: string, images: Card['images']) => {
      const commentText = String(text ?? '').trim();
      const commentImages = sanitizeCardImages(images);
      if (!commentText && commentImages.length === 0) return false;

      const localAuthor = sessionLogin ? sessionLogin.trim() || null : null;

      if (!getAuthToken()) {
        dispatch({
          type: 'CARD_COMMENT_ADD',
          cardId,
          comment: {
            id: uid(),
            text: commentText,
            images: commentImages,
            createdAt: Date.now(),
            author: localAuthor,
          },
        });
        return true;
      }

      try {
        const response = await addRemoteComment(cardId, commentText, localAuthor, commentImages);
        if (!response?.comment) return false;

        const action = {
          type: 'CARD_COMMENT_ADD' as const,
          cardId,
          comment: response.comment,
        };
        const nextState = boardReducer(board, action);
        markStateAsRemoteSynced(nextState);
        dispatch(action);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
          throw err;
        }
        return false;
      }
    },
    [board, sessionLogin]
  );

  const updateCardComment = useCallback(
    async (cardId: string, commentId: string, text: string, images: Card['images']) => {
      const commentText = String(text ?? '').trim();
      if (!board.cardsById[cardId]) return false;
      const commentImages = sanitizeCardImages(images);
      if (!commentText && commentImages.length === 0) return false;

      if (!getAuthToken()) {
        dispatch({
          type: 'CARD_COMMENT_UPDATE',
          cardId,
          commentId,
          text: commentText,
          images: commentImages,
        });
        return true;
      }

      try {
        const response = await updateRemoteComment(cardId, commentId, commentText, commentImages);
        const nextText = String(response?.comment?.text ?? commentText).trim();
        const nextImages = sanitizeCardImages(response?.comment?.images ?? commentImages);
        if (!nextText && nextImages.length === 0) return false;

        const action = {
          type: 'CARD_COMMENT_UPDATE' as const,
          cardId,
          commentId,
          text: nextText,
          images: nextImages,
        };
        const nextState = boardReducer(board, action);
        markStateAsRemoteSynced(nextState);
        dispatch(action);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
          throw err;
        }
        return false;
      }
    },
    [board]
  );

  const deleteCardComment = useCallback(
    async (cardId: string, commentId: string) => {
      if (!commentId.trim()) return false;
      if (!board.cardsById[cardId]) return false;

      if (!getAuthToken()) {
        dispatch({
          type: 'CARD_COMMENT_DELETE',
          cardId,
          commentId,
        });
        return true;
      }

      try {
        await deleteRemoteComment(cardId, commentId);
        const action = {
          type: 'CARD_COMMENT_DELETE' as const,
          cardId,
          commentId,
        };
        const nextState = boardReducer(board, action);
        markStateAsRemoteSynced(nextState);
        dispatch(action);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
          throw err;
        }
        return false;
      }
    },
    [board]
  );

  const loadCardCommentArchive = useCallback(
    async (
      cardId: string,
      options: { limit?: number; offset?: number; order?: 'asc' | 'desc'; reason?: 'overflow' | 'delete' | 'card-delete' | 'all' } = {}
    ) => {
      if (!cardId.trim()) return null;
      if (!getAuthToken()) return null;
      try {
        return await loadRemoteArchivedComments(cardId, options);
      } catch {
        return null;
      }
    },
    []
  );

  const restoreCardCommentFromArchive = useCallback(
    async (cardId: string, archiveId: number) => {
      if (!cardId.trim()) return false;
      if (!Number.isFinite(Number(archiveId)) || Number(archiveId) <= 0) return false;
      if (!board.cardsById[cardId]) return false;
      if (!getAuthToken()) return false;

      try {
        const response = await restoreRemoteArchivedComment(cardId, archiveId);
        if (!response?.comment) return false;

        const action = {
          type: 'CARD_COMMENT_ADD' as const,
          cardId,
          comment: response.comment,
        };
        const nextState = boardReducer(board, action);
        markStateAsRemoteSynced(nextState);
        dispatch(action);
        return true;
      } catch {
        return false;
      }
    },
    [board]
  );

  // фильтрация
  const matches = useCallback(
    (c: Card) => {
      if (urgFilter !== 'all' && c.urgency !== urgFilter) return false;
      if (!qNorm) return true;
      const t = (c.title ?? '').toLowerCase();
      const d = richCommentToPlainText(c.description ?? '').toLowerCase();
      const id = (c.id ?? '').toLowerCase();
      const createdBy = extractCardCreatorName(c.createdBy).toLowerCase();
      const tCompact = compactSearchValue(t);
      const dCompact = compactSearchValue(d);
      const idCompact = compactSearchValue(id);
      const createdByCompact = compactSearchValue(createdBy);
      return (
        t.includes(qNorm) ||
        d.includes(qNorm) ||
        id.includes(qNorm) ||
        createdBy.includes(qNorm) ||
        (qCompact.length > 0 &&
          (
            tCompact.includes(qCompact) ||
            dCompact.includes(qCompact) ||
            idCompact.includes(qCompact) ||
            createdByCompact.includes(qCompact)
          ))
      );
    },
    [urgFilter, qNorm, qCompact]
  );

  const filtered = useMemo(() => {
    const res: Record<ColumnId, string[]> = { queue: [], doing: [], review: [], done: [] };
    (Object.keys(res) as ColumnId[]).forEach((col) => {
      res[col] = board.columns[col].filter((id) => {
        const c = board.cardsById[id];
        return c ? matches(c) : false;
      });
    });
    return res;
  }, [board.columns, board.cardsById, matches]);

  const visibleCards = useMemo(() => {
    const res: Record<ColumnId, Card[]> = { queue: [], doing: [], review: [], done: [] };
    (Object.keys(res) as ColumnId[]).forEach((col) => {
      res[col] = filtered[col]
        .map((id) => board.cardsById[id])
        .filter((c): c is Card => !!c);
    });
    return res;
  }, [filtered, board.cardsById]);

  const visibleFloatingCards = useMemo(() => {
    return Object.entries(board.floatingById)
      .map(([id, pin]) => {
        const card = board.cardsById[id];
        return card ? { card, pin } : null;
      })
      .filter((row): row is { card: Card; pin: BoardState['floatingById'][string] } => !!row)
      .filter((row) => matches(row.card));
  }, [board.floatingById, board.cardsById, matches]);

  const getColumnBodyNode = useCallback((col: ColumnId) => {
    return document.querySelector<HTMLElement>(`.col_${col} .colBody`);
  }, []);

  const measureDropMids = useCallback(
    (col: ColumnId, activeId: string) => {
      const body = getColumnBodyNode(col);
      if (!body) return { mids: [] as number[], scrollTop: 0 };

      const mids: number[] = [];
      const nodes = body.querySelectorAll<HTMLElement>('.card[data-card-id]');
      nodes.forEach((node) => {
        const id = (node.dataset.cardId ?? '').trim();
        if (!id || id === activeId) return;
        const rect = node.getBoundingClientRect();
        mids.push(rect.top + rect.height / 2);
      });

      return { mids, scrollTop: body.scrollTop };
    },
    [getColumnBodyNode]
  );

  const resetDragLayoutCache = useCallback(() => {
    dragLayoutCacheRef.current.activeId = null;
    dragLayoutCacheRef.current.byColumn = {};
  }, []);

  const resolveDropLocation = useCallback(
    (activeId: string, overId: string, activeMidY: number): { toCol: ColumnId; toIndex: number } | null => {
      if (overId === 'trash') return null;

      const toCol = isColumnId(overId) ? overId : findColumnOfCard(overId, board.columns);
      if (!toCol) return null;

      const cache = dragLayoutCacheRef.current;
      if (cache.activeId !== activeId) {
        cache.activeId = activeId;
        cache.byColumn = {};
      }

      const currentScrollTop = getColumnBodyNode(toCol)?.scrollTop ?? 0;
      let entry = cache.byColumn[toCol];
      if (!entry || entry.scrollTop !== currentScrollTop) {
        entry = measureDropMids(toCol, activeId);
        cache.byColumn[toCol] = entry;
      }

      const mids = entry.mids;
      let lo = 0;
      let hi = mids.length;

      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (activeMidY < mids[mid]) hi = mid;
        else lo = mid + 1;
      }

      return { toCol, toIndex: lo };
    },
    [board.columns, getColumnBodyNode, measureDropMids]
  );

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const activeId = String(args.active?.id ?? '');
    const favoriteActiveCardId = fromFavoriteDragId(activeId);
    if (favoriteActiveCardId) {
      const allowFavoriteDrop = (entryId: string) =>
        Boolean(fromFavoriteDragId(entryId)) || entryId === FAVORITES_DROPPABLE_ID;

      const pointer = pointerWithin(args).filter((entry) => allowFavoriteDrop(String(entry.id)));
      if (pointer.length > 0) return pointer;

      return closestCenter(args).filter((entry) => allowFavoriteDrop(String(entry.id)));
    }

    const pointer = pointerWithin(args);
    if (pointer.length > 0) {
      const pointerWithoutCanvas = pointer.filter((entry) => String(entry.id) !== FREE_CANVAS_DROPPABLE_ID);
      if (pointerWithoutCanvas.length > 0) return pointerWithoutCanvas;
      // If only free-canvas is under pointer, keep it so cards can be pinned anywhere.
      return pointer;
    }

    const fallback = closestCenter(args);
    const fallbackWithoutCanvas = fallback.filter((entry) => String(entry.id) !== FREE_CANVAS_DROPPABLE_ID);
    return fallbackWithoutCanvas.length > 0 ? fallbackWithoutCanvas : fallback;
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const activeId = String(event.active.id);
    if (clearDragRafRef.current != null) {
      window.cancelAnimationFrame(clearDragRafRef.current);
      clearDragRafRef.current = null;
    }
    cancelPendingDragMeasure();

    setActiveDragId(activeId);
    dragLayoutCacheRef.current.activeId = activeId;
    dragLayoutCacheRef.current.byColumn = {};
    if (fromFavoriteDragId(activeId)) return;

    dragMeasureRafRef.current = window.requestAnimationFrame(() => {
      dragMeasureRafRef.current = null;
      if (dragLayoutCacheRef.current.activeId !== activeId) return;
      const byColumn: Partial<Record<ColumnId, { mids: number[]; scrollTop: number }>> = {};
      for (const col of columns) {
        byColumn[col.id] = measureDropMids(col.id, activeId);
      }
      dragLayoutCacheRef.current.byColumn = byColumn;
    });
  }, [cancelPendingDragMeasure, measureDropMids]);

  const handleDragCancel = useCallback(() => {
    if (activeDragId) {
      const favoriteCardId = fromFavoriteDragId(activeDragId);
      triggerUncrumplePulse(favoriteCardId ?? activeDragId);
    }
    cancelPendingDragMeasure();
    clearActiveDragSoon();
    resetDragLayoutCache();
  }, [
    activeDragId,
    cancelPendingDragMeasure,
    clearActiveDragSoon,
    resetDragLayoutCache,
    triggerUncrumplePulse,
  ]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;

      cancelPendingDragMeasure();
      clearActiveDragSoon();
      resetDragLayoutCache();
      const activeId = String(active.id);
      const favoriteActiveCardId = fromFavoriteDragId(activeId);
      if (favoriteActiveCardId) {
        const currentOrder = favoriteOrderRef.current;
        const activeIndex = currentOrder.indexOf(favoriteActiveCardId);
        if (activeIndex < 0) {
          triggerUncrumplePulse(favoriteActiveCardId);
          return;
        }

        if (!over) {
          triggerUncrumplePulse(favoriteActiveCardId);
          return;
        }

        const overId = String(over.id);
        const overFavoriteCardId = fromFavoriteDragId(overId);
        if (!overFavoriteCardId && overId !== FAVORITES_DROPPABLE_ID) {
          triggerUncrumplePulse(favoriteActiveCardId);
          return;
        }

        const targetIndex = overFavoriteCardId ? currentOrder.indexOf(overFavoriteCardId) : currentOrder.length - 1;
        if (targetIndex >= 0 && targetIndex !== activeIndex) {
          setFavoriteOrder((prev) => arrayMove(prev, activeIndex, targetIndex));
        }

        triggerUncrumplePulse(favoriteActiveCardId);
        return;
      }

      const now = Date.now();
      const activeRect = active.rect.current.translated ?? active.rect.current.initial;
      const fromCol = findColumnOfCard(activeId, board.columns);
      const wasFloating = Object.prototype.hasOwnProperty.call(board.floatingById, activeId);
      const prevSwayOffsetMs = board.floatingById[activeId]?.swayOffsetMs;
      const nextSwayOffsetMs =
        wasFloating && Number.isFinite(prevSwayOffsetMs) ? prevSwayOffsetMs : Math.floor(Math.random() * 2400);

      if (!over) {
        if (!activeRect) return;
        const pin = clampFloatingPlacement(activeRect);
        dispatch({
          type: 'CARD_FLOAT',
          now,
          cardId: activeId,
          x: pin.x,
          y: pin.y,
          swayOffsetMs: nextSwayOffsetMs,
        });
        triggerUncrumplePulse(activeId);
        return;
      }

      const overId = String(over.id);
      if (activeId === overId) {
        triggerUncrumplePulse(activeId);
        return;
      }

      // корзина
      if (overId === 'trash') {
        clearUndo();

        const originalCard = board.cardsById[activeId];

        if (fromCol && originalCard) {
          const index = board.columns[fromCol].indexOf(activeId);

          let cardForUndo = originalCard;

          if (fromCol === 'doing' && cardForUndo.doingStartedAt != null) {
            const add = Math.max(0, now - cardForUndo.doingStartedAt);
            cardForUndo = {
              ...cardForUndo,
              doingTotalMs: cardForUndo.doingTotalMs + add,
              doingStartedAt: null,
            };
          } else {
            cardForUndo = { ...cardForUndo, doingStartedAt: null };
          }

          setUndo({ card: cardForUndo, col: fromCol, index });
          startUndoTimer();
        }

        dispatch({ type: 'CARD_DELETE', now, cardId: activeId, historyId: uid() });

        if (activeCardId === activeId) closeEdit();
        return;
      }

      if (overId === FREE_CANVAS_DROPPABLE_ID) {
        if (!activeRect) return;
        const pin = clampFloatingPlacement(activeRect);
        dispatch({
          type: 'CARD_FLOAT',
          now,
          cardId: activeId,
          x: pin.x,
          y: pin.y,
          swayOffsetMs: nextSwayOffsetMs,
        });
        triggerUncrumplePulse(activeId);
        return;
      }

      if (!activeRect) {
        triggerUncrumplePulse(activeId);
        return;
      }
      const resolved = resolveDropLocation(activeId, overId, activeRect.top + activeRect.height / 2);
      if (!resolved) {
        triggerUncrumplePulse(activeId);
        return;
      }

      if (fromCol && fromCol === resolved.toCol) {
        const activeIndex = board.columns[fromCol].indexOf(activeId);
        if (activeIndex >= 0 && activeIndex === resolved.toIndex) {
          triggerUncrumplePulse(activeId);
          return;
        }
      }

      if (fromCol) {
        dispatch({
          type: 'CARD_MOVE',
          now,
          cardId: activeId,
          toCol: resolved.toCol,
          toIndex: resolved.toIndex,
          historyId: uid(),
        });
        triggerUncrumplePulse(activeId);
        return;
      }

      if (wasFloating) {
        dispatch({
          type: 'CARD_DOCK',
          now,
          cardId: activeId,
          toCol: resolved.toCol,
          toIndex: resolved.toIndex,
          historyId: uid(),
        });
        triggerUncrumplePulse(activeId);
      }
    },
    [
      board,
      activeCardId,
      clearActiveDragSoon,
      closeEdit,
      clearUndo,
      startUndoTimer,
      resolveDropLocation,
      resetDragLayoutCache,
      cancelPendingDragMeasure,
      triggerUncrumplePulse,
    ]
  );

  const favoriteCards = useMemo(() => {
    const ordered: Array<{ card: Card; status: ColumnId | 'freedom' }> = [];
    const seen = new Set<string>();

    for (const col of columns) {
      for (const cardId of board.columns[col.id]) {
        if (seen.has(cardId)) continue;
        const card = board.cardsById[cardId];
        if (!card || !card.isFavorite) continue;
        ordered.push({ card, status: col.id });
        seen.add(cardId);
      }
    }

    for (const cardId of Object.keys(board.floatingById ?? {})) {
      if (seen.has(cardId)) continue;
      const card = board.cardsById[cardId];
      if (!card || !card.isFavorite) continue;
      ordered.push({ card, status: 'freedom' });
      seen.add(cardId);
    }

    for (const card of Object.values(board.cardsById)) {
      if (!card.isFavorite || seen.has(card.id)) continue;
      const status = cardColumnMap.get(card.id) ?? (card.status === 'freedom' ? 'freedom' : 'queue');
      ordered.push({ card, status });
      seen.add(card.id);
    }

    return ordered;
  }, [board.cardsById, board.columns, board.floatingById, cardColumnMap]);

  useEffect(() => {
    const preferredIds = favoriteCards.map(({ card }) => card.id);
    setFavoriteOrder((prev) => {
      const preferredSet = new Set(preferredIds);
      const kept = prev.filter((id) => preferredSet.has(id));
      const keptSet = new Set(kept);
      const appended = preferredIds.filter((id) => !keptSet.has(id));
      const next = [...kept, ...appended];
      if (next.length === prev.length && next.every((id, idx) => id === prev[idx])) return prev;
      return next;
    });
  }, [favoriteCards]);

  const orderedFavoriteCards = useMemo(() => {
    if (favoriteCards.length === 0) return [] as Array<{ card: Card; status: ColumnId | 'freedom' }>;
    const byId = new Map(favoriteCards.map((item) => [item.card.id, item]));
    const out: Array<{ card: Card; status: ColumnId | 'freedom' }> = [];
    for (const id of favoriteOrder) {
      const item = byId.get(id);
      if (!item) continue;
      out.push(item);
      byId.delete(id);
    }
    for (const item of byId.values()) out.push(item);
    return out;
  }, [favoriteCards, favoriteOrder]);

  const visibleFavoriteCards = useMemo(
    () => orderedFavoriteCards.filter(({ card }) => matches(card)),
    [orderedFavoriteCards, matches]
  );

  const favoriteSortableIds = useMemo(
    () => visibleFavoriteCards.map(({ card }) => toFavoriteDragId(card.id)),
    [visibleFavoriteCards]
  );

  const handleFavoritesWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const node = favoritesScrollerRef.current;
    if (!node) return;
    if (node.scrollWidth <= node.clientWidth + 1) return;

    const dominantDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (Math.abs(dominantDelta) < 0.5) return;

    event.preventDefault();
    node.scrollLeft += dominantDelta;
  }, []);

  const overlayCard = useMemo(() => {
    if (!activeDragId) return null;
    const favoriteCardId = fromFavoriteDragId(activeDragId);
    if (favoriteCardId) return board.cardsById[favoriteCardId] ?? null;
    return board.cardsById[activeDragId] ?? null;
  }, [activeDragId, board.cardsById]);
  const crumpleOverlayCard = overlayCard;
  const isFavoriteDragActive = Boolean(activeDragId && fromFavoriteDragId(activeDragId));
  const isBoardDragActive = Boolean(activeDragId && !isFavoriteDragActive);
  const hideTopBrand = searchOpen || filtersOpen;
  const profileLikeControlsTransition = motionProfile.reducedMotion
    ? { duration: 0.01 }
    : { duration: 1.08, ease: [0.22, 0.61, 0.36, 1] as const };
  const searchControlsTransition = profileLikeControlsTransition;
  const controlsLayoutTransition = searchControlsTransition;

  return (
    <div className={`page ${isBoardDragActive ? 'pageDragActive' : 'pagePerf'}`}>
      <div className="shell">
        <div className="top topBoardHeader">
          <div className="topBoardMeta">
            <div className="topMeta">
              {sessionLogin ? (
                <div className="subAccount">
                  <button
                    type="button"
                    className="subAccountTrigger"
                    onClick={() => {
                      if (!canOpenProfileModal) return;
                      setProfileOpen((prev) => {
                        const next = !prev;
                        if (next) setFavoritesOpen(false);
                        return next;
                      });
                    }}
                    disabled={!canOpenProfileModal}
                    aria-expanded={canOpenProfileModal ? profileOpen : undefined}
                    title={sessionLogin}
                  >
                    <span className={`subAccountAvatar ${sessionAvatarUrl ? 'hasImage' : ''}`} aria-hidden="true">
                      {sessionAvatarUrl ? <img src={sessionAvatarUrl} alt="" loading="lazy" /> : sessionAvatarFallback}
                    </span>
                    <span className="subAccountEmail" title={sessionLogin}>
                      {sessionLogin}
                    </span>
                  </button>
                </div>
              ) : (
                <div className="sub">{t('board.subtitleGuest')}</div>
              )}
              <LanguageToggle />
              <BoardClock />
            </div>
          </div>

          <div className="topBoardTitleSlot" aria-hidden={hideTopBrand ? 'true' : undefined}>
            <motion.h1
              className="h1 brandTitle topBoardTitle"
              aria-label={t('app.name')}
              initial={false}
              animate={hideTopBrand ? { opacity: 0, y: -4, scale: 0.985 } : { opacity: 1, y: 0, scale: 1 }}
              transition={motionProfile.controlFadeTransition}
            >
              <img className="brandMark" src="/planorama-mark.svg" alt="" aria-hidden="true" />
              <span className="brandWord">{t('app.name')}</span>
            </motion.h1>
          </div>

          <div className="controls">
            <motion.div className="controlsActions" layout transition={controlsLayoutTransition}>
              <motion.div
                className={`searchMorph ${searchOpen ? 'isOpen' : 'isClosed'} ${q.trim().length > 0 ? 'hasText' : ''}`}
                role="search"
                layout
                transition={searchControlsTransition}
                onClick={() => {
                  if (!searchOpen) setSearchOpen(true);
                }}
              >
                <button
                  type="button"
                  className="searchMorphIconBtn"
                  title={searchOpen ? t('common.search') : t('common.openSearch')}
                  aria-label={searchOpen ? t('common.search') : t('common.openSearch')}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!searchOpen) {
                      setSearchOpen(true);
                      return;
                    }
                    searchRef.current?.focus();
                  }}
                >
                  <SearchGlyph className="searchGlyph searchGlyphRound" />
                </button>

                <input
                  ref={searchRef}
                  className="searchInput searchMorphInput"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('board.searchPlaceholder')}
                  disabled={!searchOpen}
                  tabIndex={searchOpen ? 0 : -1}
                  onFocus={() => {
                    if (!searchOpen) setSearchOpen(true);
                  }}
                  onBlur={(event) => {
                    const nextFocused = event.relatedTarget as Element | null;
                    if (nextFocused?.closest('.searchMorph')) return;
                    if (nextFocused?.closest('.filterMenuWrap')) return;
                    if (nextFocused?.closest('.favoritesToggleBtn')) return;
                    if (nextFocused?.closest('.favoritesSheetPanel')) return;
                    if (q.trim().length === 0) setSearchOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQ('');
                      setSearchOpen(false);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />

                <button
                  className="searchActionBtn searchClose searchMorphClose"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setQ('');
                    setSearchOpen(false);
                    searchRef.current?.blur();
                  }}
                  title={t('common.close')}
                  aria-label={t('common.close')}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="searchCloseIcon">
                    <path
                      d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.1"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </motion.div>

              <motion.div className="filterMenuWrap" ref={filtersRef} layout transition={controlsLayoutTransition}>
                <button
                  type="button"
                  className={`filterToggle ${urgFilter !== 'all' ? 'filterToggleActive' : ''}`}
                  title={
                    filtersOpen && urgFilter !== 'all'
                      ? t('common.reset')
                      : filtersOpen
                        ? t('board.filter.hide')
                        : t('board.filter.show')
                  }
                  aria-label={
                    filtersOpen && urgFilter !== 'all'
                      ? t('common.reset')
                      : filtersOpen
                        ? t('board.filter.hide')
                        : t('board.filter.show')
                  }
                  aria-expanded={filtersOpen}
                  aria-controls="urgency-filters-menu"
                  onClick={() => {
                    if (filtersOpen) {
                      if (urgFilter !== 'all') {
                        setUrgFilter('all');
                      }
                      setFiltersOpen(false);
                      return;
                    }
                    setFiltersOpen(true);
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    aria-hidden="true"
                    focusable="false"
                    className="filterToggleIcon"
                  >
                    <path
                      d="M3 5.75C3 5.34 3.34 5 3.75 5h16.5a.75.75 0 0 1 .58 1.23L14.5 14v5.25a.75.75 0 0 1-1.2.6l-2.5-1.88a.75.75 0 0 1-.3-.6V14L3.17 6.23A.75.75 0 0 1 3 5.75Z"
                      fill={filtersOpen ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {urgFilter !== 'all' ? <span className="filterToggleBadge" aria-hidden="true" /> : null}
                </button>

                <div
                  id="urgency-filters-menu"
                  className={`filters filtersDropdown ${filtersOpen ? 'isOpen' : 'isClosed'}`}
                  aria-label={t('modal.create.urgencyAria')}
                >
                  {FILTERS.filter((f) => f.key !== 'all').map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={`filterChip ${urgFilter === f.key ? 'filterChipActive' : ''}`}
                      data-filter={f.key}
                      title=""
                      aria-label={t(f.labelKey)}
                      onClick={() => {
                        setUrgFilter(f.key);
                      }}
                    >
                      {f.dot ? <span className={`chipDot chipDot_${f.dot}`} aria-hidden="true" /> : null}
                      {t(f.labelKey)}
                    </button>
                  ))}
                </div>
              </motion.div>

              <motion.button
                className={`iconBtn favoritesToggleBtn ${favoritesOpen ? 'isActive' : ''}`}
                onClick={() => {
                  setFavoritesOpen((prev) => {
                    const next = !prev;
                    if (next) setProfileOpen(false);
                    return next;
                  });
                }}
                title={t('board.favorites')}
                aria-label={t('board.favorites')}
                layout
                transition={motionProfile.controlLayoutTransition}
              >
                <StarGlyph className="favoriteGlyph" />
              </motion.button>

              <motion.button
                className="iconBtn"
                onClick={openCreate}
                title={t('board.createCard')}
                layout
                transition={motionProfile.controlLayoutTransition}
              >
                +
              </motion.button>
            </motion.div>
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
        >
          <FloatingCanvasDropZone />

          {visibleFloatingCards.length > 0 ? (
            <div className="floatingCardsLayer">
              {visibleFloatingCards.map(({ card, pin }) => (
                <FloatingCard
                  key={card.id}
                  card={card}
                  x={pin.x}
                  y={pin.y}
                  swayOffsetMs={pin.swayOffsetMs}
                  searchQuery={qNorm}
                  highlightPulse={searchHighlightActive ? searchHighlightPulse : 0}
                  uncrumpleToken={uncrumpleTokensById[card.id] ?? 0}
                  t={t}
                  onOpen={openEdit}
                />
              ))}
            </div>
          ) : null}

          <div className={`mainRow ${profileOpen ? 'mainRowProfileOpen' : ''}`}>
            <div className="boardWrap">
              <div className="board">
                {columns.map((col) => {
                  const allIds = board.columns[col.id];
                  const visIds = filtered[col.id];
                  const cards = visibleCards[col.id];

                  return (
                    <BoardColumn
                      key={col.id}
                      column={col}
                      allIds={allIds}
                      visIds={visIds}
                      cards={cards}
                      isFiltering={isFiltering}
                      nowTick={col.id === 'doing' ? nowTick : 0}
                      activeDoingIds={activeDoingIds}
                      searchQuery={qNorm}
                      highlightPulse={searchHighlightActive ? searchHighlightPulse : 0}
                      uncrumpleTokensById={uncrumpleTokensById}
                      dragActive={isBoardDragActive}
                      t={t}
                      onOpen={openEdit}
                    />
                  );
                })}
              </div>
            </div>

            <div
              className={[
                'side',
                isBoardDragActive ? 'sideTrashActive' : '',
                (board.history?.length ?? 0) === 0 ? 'sideHistoryEmpty' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <HistoryPanel
                items={board.history ?? []}
                existingCardIds={existingCardIds}
                nowTs={nowTick}
                locale={locale}
                t={t}
                onClear={() => dispatch({ type: 'HISTORY_CLEAR' })}
                onOpenCard={openEdit}
              />
              <TrashZone active={isBoardDragActive} t={t} />
            </div>

            <AnimatePresence initial={false}>
              {favoritesOpen ? (
                <motion.section
                  className="favoritesSheetRoot"
                  initial={false}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 1 }}
                  transition={{ duration: 0.01 }}
                >
                  <motion.div
                    className="modal favoritesSheetPanel"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('board.favorites')}
                    ref={favoritesPanelRef}
                    style={{
                      willChange: 'transform',
                      transform: 'translateZ(0)',
                      backfaceVisibility: 'hidden',
                    }}
                    initial={{ y: '-100%' }}
                    animate={{ y: '0%' }}
                    exit={{ y: '-100%' }}
                    transition={profileLikeControlsTransition}
                  >
                    <div className="modalHead favoritesSheetHead">
                      <h3 className="modalTitle">{t('board.favorites')}</h3>
                    </div>
                    <div className="modalBody favoritesSheetBody">
                      <div
                        ref={favoritesScrollerRef}
                        className="favoritesScroller"
                        onWheel={handleFavoritesWheel}
                      >
                        {orderedFavoriteCards.length === 0 ? (
                          <div className="favoritesEmptyState">{t('favorites.empty')}</div>
                        ) : visibleFavoriteCards.length === 0 ? (
                          <div className="favoritesEmptyState">{t('empty.filtered')}</div>
                        ) : (
                          <div className="favoritesTrack" ref={setFavoritesDropRef}>
                            <SortableContext items={favoriteSortableIds} strategy={rectSortingStrategy}>
                              {visibleFavoriteCards.map(({ card, status }) => (
                                <div key={`favorite-${card.id}`} className="favoritesCardSlot">
                                  <FavoriteSortableCard
                                    card={card}
                                    status={status}
                                    searchQuery={qNorm}
                                    highlightPulse={searchHighlightActive ? searchHighlightPulse : 0}
                                    onOpen={openEdit}
                                    onToggleFavorite={toggleCardFavorite}
                                    t={t}
                                  />
                                </div>
                              ))}
                            </SortableContext>
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                </motion.section>
              ) : null}
            </AnimatePresence>

            {profileModalLoaded ? (
              <Suspense fallback={null}>
                <ProfileModal
                  open={profileOpen}
                  user={sessionUser ?? null}
                  onClose={() => setProfileOpen(false)}
                  onSave={onProfileSave}
                  onLogout={onLogout}
                  createdTasksCount={createdTasksCount}
                  commentsCount={commentsTotalCount}
                />
              </Suspense>
            ) : null}
          </div>

          <DragOverlay
            dropAnimation={
              crumpleOverlayCard
                ? null
                : motionProfile.overlayDropDurationMs > 0
                ? {
                    duration: motionProfile.overlayDropDurationMs,
                    easing: motionProfile.overlayDropEasing,
                  }
                : null
            }
          >
            {overlayCard ? (
              !motionProfile.reducedMotion && crumpleOverlayCard ? (
                <CrumpleCanvasOverlay
                  card={crumpleOverlayCard}
                  reducedMotion={motionProfile.reducedMotion}
                  lowPower={motionProfile.isMobile}
                />
              ) : (
                <div className="card cardOverlay" data-u={overlayCard.urgency}>
                  <div className="urgBar" />
                  <div className="cardMeta">
                    <span className="cardId" title={t('card.id.title', { id: overlayCard.id })}>
                      {formatCardId(overlayCard.id)}
                    </span>
                  </div>
                  <p
                    className="cardCreator"
                    title={t('card.creator.title', {
                      name: extractCardCreatorName(overlayCard.createdBy) || t('card.creator.unknown'),
                    })}
                  >
                    {extractCardCreatorName(overlayCard.createdBy) || t('card.creator.unknown')}
                  </p>
                  <p className="cardTitle">{overlayCard.title || t('common.untitled')}</p>
                  <p className="cardDesc">{richCommentToPlainText(overlayCard.description || '') || '—'}</p>
                </div>
              )
            ) : null}
          </DragOverlay>
        </DndContext>

        {createModalLoaded ? (
          <Suspense fallback={null}>
            <CardModal open={createOpen} onClose={() => setCreateOpen(false)} onCreate={createCard} />
          </Suspense>
        ) : null}

        {editModalLoaded ? (
          <Suspense fallback={null}>
            <EditModal
              key={activeCard?.id ?? 'closed'}
              open={editOpen}
              card={activeCard}
              cardColumn={activeCardColumn}
              onChangeStatus={(column) => {
                if (!activeCard) return;
                changeCardStatus(activeCard.id, column);
              }}
              readOnly={!!isReadOnly}
              commentAuthor={sessionLogin ? sessionLogin.trim() || null : null}
              onClose={closeEdit}
              onToggleFavorite={toggleCardFavorite}
              onChecklistChange={(checklist) => {
                if (!activeCard) return;
                updateCardChecklist(activeCard.id, checklist);
              }}
              onSave={(patch) => {
                if (!activeCard) return;
                updateCard(activeCard.id, patch);
              }}
              onAddComment={(text, images) => {
                if (!activeCard) return false;
                return addCardComment(activeCard.id, text, images);
              }}
              onUpdateComment={(commentId, text, images) => {
                if (!activeCard) return false;
                return updateCardComment(activeCard.id, commentId, text, images);
              }}
              onDeleteComment={(commentId) => {
                if (!activeCard) return false;
                return deleteCardComment(activeCard.id, commentId);
              }}
              onLoadCommentArchive={(options) => {
                if (!activeCard) return null;
                return loadCardCommentArchive(activeCard.id, options);
              }}
              onRestoreArchivedComment={(archiveId) => {
                if (!activeCard) return false;
                return restoreCardCommentFromArchive(activeCard.id, archiveId);
              }}
              canUseCommentArchive={!!getAuthToken()}
              showDoingTimer={showDoingTimer}
              doingMs={doingMs}
            />
          </Suspense>
        ) : null}

        {undo ? (
          <div className="toastUndo" role="status" aria-live="polite">
            <div className="toastUndoText">
              {t('toast.deleted')} <span className="toastUndoTitle">{undo.card.title || t('common.untitled')}</span>
            </div>

            <button className="toastUndoBtn" onClick={undoDelete} type="button">
              {t('toast.undo')}
            </button>

            <button
              className="toastUndoX"
              onClick={clearUndo}
              type="button"
              aria-label={t('toast.close')}
              title={t('toast.close')}
            >
              ?
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}








