/**
 * probe.js — ffprobe 封装 + 旋转归一。纯 IO 层，不做决策。
 *
 * 两个安静出错的坑（都有测试）：
 *  1. 手机竖拍常是"编码 1920×1080 + rotation 90"，ffmpeg 解码会转正，ffprobe 报的是编码尺寸；
 *     拿编码尺寸去算 scale 会把画面拉扁。
 *  2. 末尾边界没有帧：时长的最后一帧在 duration - 1/fps 附近，-ss duration 抽不出东西。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const DEFAULT_FFMPEG = process.env.DSH_FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg';
export const DEFAULT_FFPROBE = process.env.DSH_FFPROBE_PATH || process.env.FFPROBE_PATH || 'ffprobe';

/** "25/1" | "30000/1001" → number | null */
export function parseRational(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [num, den = '1'] = value.split('/');
  const a = Number(num);
  const b = Number(den);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 旋转角归一化到 (-180, 180] */
export function normalizeRotation(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  let a = v % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.round(a);
}

/** 旋转 90/270 时，观众看到的宽高与编码宽高互换 */
export function uprightSize(codedWidth, codedHeight, rotation) {
  return Math.abs(rotation) % 180 === 90
    ? { width: codedHeight, height: codedWidth }
    : { width: codedWidth, height: codedHeight };
}

/** 末尾避让量：等分采样最后一帧若取 duration，会落在"不存在的帧"上 */
export const endEdge = (fps) => (fps > 0 ? 0.5 / fps : 0.02);

export async function probeVideo(input, { ffprobePath = DEFAULT_FFPROBE } = {}) {
  const { stdout } = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe did not return JSON for "${input}"`);
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((s) => s?.codec_type === 'video');
  if (!video) throw new Error(`"${input}" has no video stream`);
  const audio = streams.find((s) => s?.codec_type === 'audio');
  const subtitle = streams.find((s) => s?.codec_type === 'subtitle');

  const duration =
    Number(parsed?.format?.duration) || Number(video?.duration) || 0;
  const rotation = normalizeRotation(
    video?.side_data_list?.find((d) => d?.rotation !== undefined)?.rotation ?? video?.tags?.rotate,
  );
  const coded = { width: Number(video.width) || 0, height: Number(video.height) || 0 };
  const { width, height } = uprightSize(coded.width, coded.height, rotation);
  const fps = parseRational(video.r_frame_rate) ?? parseRational(video.avg_frame_rate) ?? 25;

  return {
    duration,
    width,
    height,
    coded,
    rotation,
    fps,
    aspect: height > 0 ? width / height : 16 / 9,
    videoCodec: video.codec_name ?? 'unknown',
    container: parsed?.format?.format_name ?? 'unknown',
    hasAudio: Boolean(audio),
    hasSubtitle: Boolean(subtitle),
    audioCodec: audio?.codec_name ?? null,
  };
}
