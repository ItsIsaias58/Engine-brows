// Helpers puros y tipos del reproductor, extraídos de Player.tsx (que era una
// god class de ~2800 líneas). Sin estado ni efectos: solo formateo, parseo y
// política de carga de hls. Se mueven aquí para que el componente se ocupe del
// ciclo de vida y no de la aritmética.
import { RequestError } from "../../core/runtime/messages.ts";
import {
  appendMegaPlayParams,
  hasMegaPlayIdentifier,
  normalizeAnimeIds,
  type AnimeIds,
} from "../../features/anime/animeIdentity.ts";

export const STREAM_INFO_TIMEOUT_MS = 12_000;
export const SUBTITLE_PREFERENCE_KEY = "lyra-anime-subtitle";

export interface StreamSubtitleTrack {
  label: string;
  language: string;
  src: string;
  kind?: "subtitles" | "captions" | string;
  default?: boolean;
}

export interface StreamQualityOption {
  index: number;
  label: string;
  width: number;
  height: number;
  bitrate: number;
}

export interface StreamAudioTrack {
  label: string;
  language: string;
  default?: boolean;
}

export interface StreamInfoResponse {
  duration?: number | null;
  needs_transmux?: boolean;
  hls?: boolean;
  tracks?: StreamSubtitleTrack[];
  audio_tracks?: StreamAudioTrack[];
  source?: {
    id?: string;
    server?: number | string;
    language?: "sub" | "dub" | string | null;
    url?: string;
  };
  intro?: { start: number; end: number } | null;
  outro?: { start: number; end: number } | null;
  qualities?: Array<{
    index: number;
    width?: number;
    height?: number;
    bitrate?: number;
    codecs?: string;
  }>;
}

export type PlayerStatus =
  | "idle"
  | "loading"
  | "buffering"
  | "waiting"
  | "stalled"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export interface PlaybackEpisodePartRange {
  start: number;
  end: number;
  ids: AnimeIds;
}

export function mergeEpisodeCount(...counts: number[]): number {
  return counts.reduce(
    (largest, count) =>
      Number.isInteger(count) && count > largest ? count : largest,
    0,
  );
}

export function resolvePlayerStatus(
  status: PlayerStatus,
  hasSource: boolean,
  detailsLoading: boolean,
): PlayerStatus {
  if (!hasSource) return "idle";
  if (status === "error") return status;
  return detailsLoading ? "loading" : status;
}

export function parsePlaybackEpisodeParts(value: string | null): PlaybackEpisodePartRange[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as {
        start?: unknown;
        end?: unknown;
        ids?: unknown;
      };
      const start = Number(candidate.start);
      const end = Number(candidate.end);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end < start ||
        !candidate.ids ||
        typeof candidate.ids !== "object"
      ) {
        return [];
      }
      return [{ start, end, ids: normalizeAnimeIds(candidate.ids as AnimeIds) }];
    });
  } catch {
    return [];
  }
}

export async function fetchStreamInfo(
  params: URLSearchParams,
  signal?: AbortSignal,
): Promise<StreamInfoResponse> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "stream information request timed out... /ᐠ - ˕ -マ",
          "TimeoutError",
        ),
      ),
    STREAM_INFO_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`/stream/info?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RequestError("stream information request failed", {
        code: "STREAM_INFO_UNAVAILABLE",
        status: response.status,
      });
    }
    return (await response.json()) as StreamInfoResponse;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new RequestError("stream information request timed out", {
        code: "STREAM_INFO_TIMEOUT",
      });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const formattedMinutes = minutes.toString().padStart(2, "0");
  const formattedSeconds = remainingSeconds.toString().padStart(2, "0");

  return hours > 0
    ? `${hours}:${formattedMinutes}:${formattedSeconds}`
    : `${minutes}:${formattedSeconds}`;
}

export function cleanDuration(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function hasBufferedTime(video: HTMLVideoElement, seconds: number): boolean {
  for (let i = 0; i < video.buffered.length; i++) {
    if (
      seconds >= video.buffered.start(i) - 0.25 &&
      seconds <= video.buffered.end(i) + 0.25
    ) {
      return true;
    }
  }
  return false;
}

export function buildNextEpisodeStreamUrl(
  episode: number,
  episodeParts: PlaybackEpisodePartRange[],
  identityIds: AnimeIds,
  language: "sub" | "dub",
): string {
  const part = episodeParts.find(
    (candidate) => episode >= candidate.start && episode <= candidate.end,
  );
  const sourceEpisode = part ? episode - part.start + 1 : episode;
  const ids = normalizeAnimeIds({
    ...(part?.ids || identityIds),
    anikotoEpisode: undefined,
  });
  if (!hasMegaPlayIdentifier(ids)) return "";
  const query = new URLSearchParams({
    episode: String(sourceEpisode),
    language,
  });
  appendMegaPlayParams(query, ids);
  return `/stream/anikoto?${query}`;
}

export function cueTextToPlainText(value: string): string {
  const template = document.createElement("template");
  template.innerHTML = value.replace(/<br\s*\/?>/gi, "\n");
  return template.content.textContent?.trim() || "";
}

export function subtitlePreference(track: StreamSubtitleTrack): string {
  return `${track.language || "und"}|${track.label}`.toLowerCase();
}

export function isEnglishSubtitle(track: StreamSubtitleTrack): boolean {
  const language = track.language.trim().toLowerCase();
  const label = track.label.trim().toLowerCase();
  return (
    language === "en" ||
    language.startsWith("en-") ||
    /\benglish\b|\beng\b/.test(label)
  );
}

export function qualityLabel(height: number, bitrate: number): string {
  if (height > 0) {
    const rate = bitrate > 0 ? ` · ${(bitrate / 1_000_000).toFixed(1)} mbps` : "";
    return `${height}p${rate}`;
  }
  return bitrate > 0 ? `${(bitrate / 1_000_000).toFixed(1)} mbps` : "source";
}

export function qualityName(label: string | undefined): string {
  return label?.split(" · ", 1)[0] || "source";
}

export function hlsLoadPolicy(
  maxTimeToFirstByteMs: number,
  maxLoadTimeMs: number,
  timeoutRetries: number,
  errorRetries: number,
) {
  return {
    default: {
      maxTimeToFirstByteMs,
      maxLoadTimeMs,
      timeoutRetry: {
        maxNumRetry: timeoutRetries,
        retryDelayMs: 500,
        maxRetryDelayMs: 4_000,
        backoff: "exponential" as const,
      },
      errorRetry: {
        maxNumRetry: errorRetries,
        retryDelayMs: 500,
        maxRetryDelayMs: 5_000,
        backoff: "exponential" as const,
      },
    },
  };
}
