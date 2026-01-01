#!/usr/bin/env node

require("dotenv").config();

/**
 * ClipFlow FFmpeg Render Worker
 *
 * Polls worker-api for tasks, downloads source, runs FFmpeg, uploads via API.
 * No direct Supabase credentials required - uses WORKER_API_KEY.
 *
 * Required env vars:
 *   WORKER_API_URL     - Full URL to worker-api (e.g., https://<project>.supabase.co/functions/v1/worker-api)
 *   WORKER_API_KEY     - Secret key for x-worker-api-key header
 *
 * Optional:
 *   WORKER_ID
 *   POLL_INTERVAL_MS
 *   CONCURRENCY
 *   MAX_ATTEMPTS
 *   RENDER_TIMEOUT_MS
 */

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const os = require("os");

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const WORKER_API_URL = process.env.WORKER_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const WORKER_ID =
  process.env.WORKER_ID || `worker-${Math.random().toString(36).slice(2, 8)}`;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "2", 10);
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || "3", 10);
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || "300000", 10);

if (!WORKER_API_URL || !WORKER_API_KEY) {
  console.error("❌ Missing WORKER_API_URL or WORKER_API_KEY\n");
  console.error("Required environment variables:");
  console.error("  WORKER_API_URL  - Full URL to worker-api endpoint");
  console.error("  WORKER_API_KEY  - Secret key for authentication\n");
  console.error("Example:");
  console.error(
    "  WORKER_API_URL=https://jnrpgmdqqfojnsctvdnc.supabase.co/functions/v1/worker-api"
  );
  console.error("  WORKER_API_KEY=your-secret-key");
  process.exit(1);
}

let activeRenders = 0;
let isShuttingDown = false;

// ─────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(
    JSON.stringify({ timestamp, level, worker: WORKER_ID, message, ...data })
  );
}

// ─────────────────────────────────────────────────────────────
// Worker API client
// ─────────────────────────────────────────────────────────────

async function callWorkerApi(action, payload = {}) {
  // Node 18+ has global fetch. If you're on older Node, upgrade.
  const response = await fetch(WORKER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-worker-api-key": WORKER_API_KEY,
    },
    body: JSON.stringify({ action, ...payload }),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    // ignore
  }

  if (!response.ok) {
    const msg = (data && data.error) || `API error: ${response.status}`;
    throw new Error(msg);
  }

  return data || {};
}

// ─────────────────────────────────────────────────────────────
// File utilities
// ─────────────────────────────────────────────────────────────

function getTempDir() {
  const dir = path.join(os.tmpdir(), "clipflow-worker");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class NonRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = "NonRetryableError";
    this.nonRetryable = true;
  }
}

function cleanupFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    log("warn", "Failed to cleanup file", { path: filePath, error: e.message });
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === "https:" ? https : http;
    const file = fs.createWriteStream(destPath);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
      },
    };

    const request = protocol.request(options, (response) => {
      // Redirects
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        file.close();
        cleanupFile(destPath);
        return downloadFile(response.headers.location, destPath)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        cleanupFile(destPath);
        return reject(
          new Error(`Download failed: HTTP ${response.statusCode} from ${urlObj.hostname}`)
        );
      }

      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(destPath)));
    });

    request.on("error", (err) => {
      file.close();
      cleanupFile(destPath);
      reject(err);
    });

    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error("Download timeout"));
    });

    request.end();
  });
}

// ─────────────────────────────────────────────────────────────
// URL classification helpers
// ─────────────────────────────────────────────────────────────

function isDirectMediaUrl(url) {
  const lowerUrl = url.toLowerCase();
  const directExtensions = [".mp4", ".mov", ".mkv", ".webm", ".m3u8"];
  
  // Check for direct file extensions
  for (const ext of directExtensions) {
    if (lowerUrl.includes(ext)) return true;
  }
  
  // Check for known CDN/storage patterns
  if (url.includes("storage/v1/object")) return true;
  if (url.includes("twitchcdn.net")) return true;
  if (url.includes("clips-media-assets")) return true;
  
  return false;
}

function shouldUseYtDlp(url) {
  // If it's direct media, no need for yt-dlp
  if (isDirectMediaUrl(url)) return false;
  
  const lowerUrl = url.toLowerCase();
  
  // Video platforms that require yt-dlp
  const ytDlpDomains = [
    "youtube.com",
    "youtu.be",
    "tiktok.com",
    "rumble.com",
    "kick.com",
    "twitter.com",
    "x.com",
    "twitch.tv",
    "clips.twitch.tv",
  ];
  
  for (const domain of ytDlpDomains) {
    if (lowerUrl.includes(domain)) return true;
  }
  
  // Check for common video URL patterns
  if (lowerUrl.includes("watch?v=")) return true;
  if (lowerUrl.includes("/shorts/")) return true;
  if (lowerUrl.includes("/clip/")) return true;
  
  return false;
}

function getUrlDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return "unknown";
  }
}

// ─────────────────────────────────────────────────────────────
// yt-dlp download (YouTube, Twitch, etc.)
// ─────────────────────────────────────────────────────────────

function runYtDlp(url, outPath) {
  return new Promise((resolve, reject) => {
    const domain = getUrlDomain(url);
    
    // yt-dlp output template - ensure exact path without extra extensions
    // Remove .mp4 extension from outPath if present (yt-dlp will add it back)
    const baseOutPath = outPath.replace(/\.mp4$/i, "");
    const expectedOutputPath = baseOutPath + ".mp4";
    
    log("info", "Downloading via yt-dlp", {
      url: url.substring(0, 120),
      domain,
      outPath: expectedOutputPath,
    });

    // Force MP4 output format for compatibility
    const args = [
      "-f", "bv*+ba/b",                    // Best video + best audio, or best combined
      "--merge-output-format", "mp4",       // Force MP4 container
      "--no-playlist",                      // Don't download playlists
      "--restrict-filenames",               // Safe filenames  
      "--no-part",                          // Don't use .part files
      "--no-mtime",                         // Don't modify file time
      "-o", expectedOutputPath,             // Output path
      url,
    ];

    log("info", "yt-dlp args", { args: args.join(" ") });

    execFile(
      "yt-dlp",
      args,
      { timeout: 300000 },  // 5 minute timeout for longer videos
      (err, stdout, stderr) => {
        // Log yt-dlp output for debugging
        if (stdout) log("info", "yt-dlp stdout", { stdout: stdout.slice(-500) });
        if (stderr) log("info", "yt-dlp stderr", { stderr: stderr.slice(-500) });
        
        if (err) {
          if (err.code === "ENOENT") {
            return reject(new NonRetryableError("yt-dlp not installed"));
          }
          // Check for auth/permission errors
          if (stderr && (stderr.includes("HTTP Error 401") || stderr.includes("HTTP Error 403"))) {
            return reject(new NonRetryableError(`Access denied for ${domain}: ${stderr.slice(-200)}`));
          }
          return reject(new Error(`yt-dlp failed for ${domain}: ${stderr || err.message}`));
        }

        // Check if output file exists at expected path
        let finalPath = expectedOutputPath;
        if (!fs.existsSync(expectedOutputPath)) {
          // Try with original path (without stripping .mp4)
          if (fs.existsSync(outPath)) {
            finalPath = outPath;
          } else {
            // List temp directory to debug
            const tempDir = path.dirname(expectedOutputPath);
            const files = fs.readdirSync(tempDir);
            log("error", "yt-dlp output not found", { 
              expectedPath: expectedOutputPath, 
              tempDirContents: files.slice(0, 20),
            });
            return reject(new Error(`yt-dlp completed but output file not found at ${expectedOutputPath}`));
          }
        }

        // If output was saved at a different path, rename to expected path
        if (finalPath !== outPath && fs.existsSync(finalPath) && !fs.existsSync(outPath)) {
          fs.renameSync(finalPath, outPath);
          finalPath = outPath;
        }

        // Verify file is valid (not HTML or too small)
        const stats = fs.statSync(finalPath);
        const minSizeBytes = 100 * 1024; // 100KB minimum
        
        if (stats.size < minSizeBytes) {
          return reject(new NonRetryableError(`Downloaded file too small (${stats.size} bytes) - likely not valid video`));
        }

        log("info", "yt-dlp download complete", { 
          outPath: finalPath, 
          domain,
          sizeBytes: stats.size,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        });
        resolve({ stdout, stderr, sizeBytes: stats.size, path: finalPath });
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────
// FFmpeg execution
// ─────────────────────────────────────────────────────────────

function runFFmpeg(inputPath, outputPath, task) {
  return new Promise((resolve, reject) => {
    const input = task.input || {};
    const timing = input.timing || {};
    const render = input.render || {};
    const ffmpegConfig = render.ffmpeg || {};

    const startSec = Number.isFinite(timing.start_sec) ? timing.start_sec : 0;
    const endSec = Number.isFinite(timing.end_sec) ? timing.end_sec : startSec + 30;
    const duration = Math.max(0.1, endSec - startSec);

    const args = ["-y", "-i", inputPath];

    // Trim
    args.push("-ss", String(startSec));
    args.push("-t", String(duration));

    // Optional filter_complex
    if (ffmpegConfig.filter_complex) {
      args.push("-filter_complex", ffmpegConfig.filter_complex);
    }

    const outputArgs = ffmpegConfig.output_args || [
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
    ];

    args.push(...outputArgs);
    args.push(outputPath);

    log("info", "Running FFmpeg", { args: args.join(" ") });

    const ffmpeg = spawn("ffmpeg", args, { windowsHide: true });

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      reject(new Error("FFmpeg timeout"));
    }, RENDER_TIMEOUT_MS);

    ffmpeg.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolve(outputPath);
      reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-800)}`));
    });

    ffmpeg.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Upload via worker-api
// ─────────────────────────────────────────────────────────────

async function uploadToStorage(filePath, storagePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const stats = fs.statSync(filePath);
  const base64Content = fileBuffer.toString("base64");

  log("info", "Uploading via worker-api", { storagePath, size: stats.size });

  const result = await callWorkerApi("upload", {
    path: storagePath,
    base64_content: base64Content,
    content_type: "video/mp4",
  });

  return {
    path: storagePath,
    mp4_url: result.public_url,
    size_bytes: stats.size,
  };
}

// ─────────────────────────────────────────────────────────────
// Task processing
// ─────────────────────────────────────────────────────────────

async function claimTask() {
  try {
    const result = await callWorkerApi("claim", { worker_id: WORKER_ID });
    return result.task || null;
  } catch (error) {
    log("error", "Failed to claim task", { error: error.message });
    return null;
  }
}

async function updateTask(taskId, status, output = null, error = null) {
  try {
    await callWorkerApi("update", {
      task_id: taskId,
      status,
      output,
      error,
    });
  } catch (err) {
    log("error", "Failed to update task", { taskId, error: err.message });
  }
}

async function processTask(task) {
  const taskId = task.id;
  const jobId = task.job_id;
  const userId = task.user_id;
  const clipIndex = task.clip_index;
  const attempts = task.attempts ?? 0;
  const taskType = task.task_type || "clip_render";

  log("info", "Processing task", { taskId, jobId, clipIndex, attempts, taskType });

  const tempDir = getTempDir();

  // Route to appropriate handler based on task type
  if (taskType === "ai_story_render") {
    await processAiStoryTask(task, tempDir);
  } else {
    await processClipRenderTask(task, tempDir);
  }
}

// Process standard clip render tasks
async function processClipRenderTask(task, tempDir) {
  const taskId = task.id;
  const jobId = task.job_id;
  const userId = task.user_id;
  const clipIndex = task.clip_index;
  const attempts = task.attempts ?? 0;

  const inputPath = path.join(tempDir, `input_${taskId}.mp4`);
  const outputPath = path.join(tempDir, `output_${taskId}.mp4`);

  try {
    if (attempts >= MAX_ATTEMPTS) {
      throw new NonRetryableError(`Max attempts (${MAX_ATTEMPTS}) exceeded`);
    }

    const input = task.input || {};
    const clipUrl = input.clip_url;

    if (!clipUrl) {
      throw new NonRetryableError("No clip_url in task input");
    }

    const domain = getUrlDomain(clipUrl);
    const useYtDlp = shouldUseYtDlp(clipUrl);

    // Download using appropriate method
    if (useYtDlp) {
      log("info", "Using yt-dlp for platform video", { domain, clipUrl: clipUrl.substring(0, 100) });
      await runYtDlp(clipUrl, inputPath);
    } else {
      log("info", "Downloading via direct fetch", { domain, url: clipUrl.substring(0, 120) });
      await downloadFile(clipUrl, inputPath);
      
      // Verify downloaded file is valid video (not HTML)
      const stats = fs.statSync(inputPath);
      const minSizeBytes = 50 * 1024; // 50KB minimum for direct downloads
      
      if (stats.size < minSizeBytes) {
        throw new NonRetryableError(`Downloaded file too small (${stats.size} bytes) - may not be valid video`);
      }
      
      log("info", "Direct download complete", { inputPath, sizeBytes: stats.size });
    }

    // Render
    await runFFmpeg(inputPath, outputPath, task);

    // Upload
    const template = input.ai3?.template || "default";
    const storagePath = `renders/${userId}/${jobId}/${clipIndex}_${template}.mp4`;
    const uploadResult = await uploadToStorage(outputPath, storagePath);

    // Done
    await updateTask(taskId, "done", uploadResult, null);
    log("info", "Task completed successfully", {
      taskId,
      mp4_url: uploadResult.mp4_url,
    });
  } catch (error) {
    log("error", "Task failed", {
      taskId,
      error: error.message,
      nonRetryable: !!error.nonRetryable,
    });

    const shouldFail = error.nonRetryable || attempts + 1 >= MAX_ATTEMPTS;
    if (shouldFail) {
      await updateTask(taskId, "failed", null, error.message);
    } else {
      // requeue
      await updateTask(taskId, "queued", null, null);
    }
  } finally {
    cleanupFile(inputPath);
    cleanupFile(outputPath);
    activeRenders = Math.max(0, activeRenders - 1);
  }
}

// Process AI story render tasks (slideshow with audio)
async function processAiStoryTask(task, tempDir) {
  const taskId = task.id;
  const jobId = task.job_id;
  const userId = task.user_id;
  const attempts = task.attempts ?? 0;
  const input = task.input || {};

  log("info", "=== AI STORY RENDER PATH ===", { taskId, jobId });

  const audioPath = path.join(tempDir, `audio_${taskId}.mp3`);
  const outputPath = path.join(tempDir, `story_${taskId}.mp4`);
  const imagePaths = [];

  try {
    if (attempts >= MAX_ATTEMPTS) {
      throw new NonRetryableError(`Max attempts (${MAX_ATTEMPTS}) exceeded`);
    }

    const audioUrl = input.audio_url;
    const imageUrls = input.image_urls || [];
    const sceneDurations = input.scene_durations || [];
    const sceneTimings = input.scene_timings || [];
    const srt = input.srt || "";
    const outputSettings = input.output_settings || { width: 1080, height: 1920, fps: 30 };

    // Validate required inputs
    if (!audioUrl) {
      throw new NonRetryableError("No audio_url in AI story task input");
    }
    if (imageUrls.length === 0) {
      throw new NonRetryableError("No image_urls in AI story task input");
    }

    log("info", "AI Story render starting", {
      taskId,
      imageCount: imageUrls.length,
      hasAudio: !!audioUrl,
      hasSrt: srt.length > 0,
      sceneDurations,
    });

    // Download audio
    log("info", "Downloading audio...", { url: audioUrl.substring(0, 100) });
    await downloadFile(audioUrl, audioPath);
    log("info", "Audio downloaded successfully", { path: audioPath });

    // Download images
    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      if (!imgUrl) continue;
      
      const imgPath = path.join(tempDir, `scene_${taskId}_${i}.png`);
      try {
        await downloadFile(imgUrl, imgPath);
        imagePaths.push({ path: imgPath, index: i });
      } catch (imgErr) {
        log("warn", `Failed to download image ${i}`, { error: imgErr.message });
      }
    }

    if (imagePaths.length === 0) {
      throw new NonRetryableError("No images available for slideshow");
    }

    log("info", `Downloaded ${imagePaths.length} images for slideshow`);

    // Build FFmpeg command for slideshow
    await runAiStoryFFmpeg({
      imagePaths,
      audioPath: audioUrl ? audioPath : null,
      outputPath,
      sceneDurations,
      sceneTimings,
      srt,
      outputSettings,
      tempDir,
      taskId,
    });

    // Upload
    const storagePath = `ai-stories/${userId}/${jobId}/final.mp4`;
    const uploadResult = await uploadToStorage(outputPath, storagePath);

    // Done
    await updateTask(taskId, "done", uploadResult, null);
    log("info", "AI Story render completed", {
      taskId,
      mp4_url: uploadResult.mp4_url,
    });
  } catch (error) {
    log("error", "AI Story task failed", {
      taskId,
      error: error.message,
      nonRetryable: !!error.nonRetryable,
    });

    const shouldFail = error.nonRetryable || attempts + 1 >= MAX_ATTEMPTS;
    if (shouldFail) {
      await updateTask(taskId, "failed", null, error.message);
    } else {
      await updateTask(taskId, "queued", null, null);
    }
  } finally {
    // Cleanup
    cleanupFile(audioPath);
    cleanupFile(outputPath);
    for (const img of imagePaths) {
      cleanupFile(img.path);
    }
    activeRenders = Math.max(0, activeRenders - 1);
  }
}

// FFmpeg for AI story slideshow
async function runAiStoryFFmpeg(opts) {
  const {
    imagePaths,
    audioPath,
    outputPath,
    sceneDurations,
    sceneTimings,
    srt,
    outputSettings,
    tempDir,
    taskId,
  } = opts;

  return new Promise((resolve, reject) => {
    const width = outputSettings.width || 1080;
    const height = outputSettings.height || 1920;
    const fps = outputSettings.fps || 30;

    // Create concat demuxer file for images
    // Use forward slashes for FFmpeg compatibility on Windows
    const concatFilePath = path.join(tempDir, `concat_${taskId}.txt`);
    let concatContent = "";

    for (let i = 0; i < imagePaths.length; i++) {
      const img = imagePaths.find((p) => p.index === i);
      if (!img) continue;

      // Get duration for this scene
      let duration = 5; // default 5 seconds
      if (sceneTimings[i]) {
        duration = sceneTimings[i].duration || (sceneTimings[i].end_sec - sceneTimings[i].start_sec);
      } else if (sceneDurations[i]) {
        duration = sceneDurations[i];
      }

      // Use forward slashes for FFmpeg on all platforms
      const imgPathEscaped = img.path.replace(/\\/g, "/");
      concatContent += `file '${imgPathEscaped}'\n`;
      concatContent += `duration ${duration}\n`;
    }

    // Add last image again (FFmpeg concat demuxer quirk)
    const lastImg = imagePaths[imagePaths.length - 1];
    if (lastImg) {
      const lastPathEscaped = lastImg.path.replace(/\\/g, "/");
      concatContent += `file '${lastPathEscaped}'\n`;
    }

    fs.writeFileSync(concatFilePath, concatContent);
    log("info", "Created concat file", { path: concatFilePath, scenes: imagePaths.length });

    const args = ["-y"];

    // Input: image sequence via concat demuxer
    args.push("-f", "concat", "-safe", "0", "-i", concatFilePath);

    // Input: audio (if available)
    if (audioPath && fs.existsSync(audioPath)) {
      args.push("-i", audioPath);
    }

    // Build filter - use forward slashes for FFmpeg on all platforms
    const escapeFFmpegPath = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:");
    
    let filterComplex = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps}`;

    // Add captions if SRT available
    if (srt && srt.trim().length > 0) {
      const srtPath = path.join(tempDir, `captions_${taskId}.srt`);
      fs.writeFileSync(srtPath, srt);
      const escapedSrtPath = escapeFFmpegPath(srtPath);
      filterComplex += `,subtitles='${escapedSrtPath}'`;
      log("info", "SRT captions will be burned in", { srtPath: escapedSrtPath });
    }

    filterComplex += "[v]";
    args.push("-filter_complex", filterComplex);
    args.push("-map", "[v]");

    // Map audio if present
    if (audioPath && fs.existsSync(audioPath)) {
      args.push("-map", "1:a");
      args.push("-c:a", "aac", "-b:a", "192k");
      args.push("-shortest"); // End when shortest stream ends
    }

    // Output settings
    args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23");
    args.push("-pix_fmt", "yuv420p");
    args.push("-movflags", "+faststart");
    args.push(outputPath);

    log("info", "Running AI story FFmpeg", { args: args.join(" ") });

    const ffmpeg = spawn("ffmpeg", args, { windowsHide: true });

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      reject(new Error("AI Story FFmpeg timeout"));
    }, RENDER_TIMEOUT_MS);

    ffmpeg.on("close", (code) => {
      clearTimeout(timeout);
      cleanupFile(concatFilePath);
      if (code === 0) return resolve(outputPath);
      reject(new Error(`AI Story FFmpeg exited with code ${code}: ${stderr.slice(-800)}`));
    });

    ffmpeg.on("error", (err) => {
      clearTimeout(timeout);
      cleanupFile(concatFilePath);
      reject(err);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Main poll loop
// ─────────────────────────────────────────────────────────────

async function pollLoop() {
  if (isShuttingDown) return;

  if (activeRenders >= CONCURRENCY) {
    setTimeout(pollLoop, POLL_INTERVAL_MS);
    return;
  }

  try {
    const task = await claimTask();
    if (task) {
      activeRenders++;
      log("info", "Claimed task", { taskId: task.id, activeRenders });

      processTask(task).catch((err) => {
        log("error", "Unhandled error in processTask", { error: err.message });
      });

      if (activeRenders < CONCURRENCY) {
        setImmediate(pollLoop);
        return;
      }
    } else {
      log("debug", "No tasks available", { activeRenders });
    }
  } catch (error) {
    log("error", "Poll loop error", { error: error.message });
  }

  setTimeout(pollLoop, POLL_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────
// Startup / Shutdown
// ─────────────────────────────────────────────────────────────

async function testConnection() {
  try {
    // worker-api doesn't have "test" – use a safe claim call as the connectivity test
    const res = await callWorkerApi("claim", { worker_id: WORKER_ID });

    const task = res.task || null;

    // If we actually claimed a task, put it straight back to queued so we don't "steal" it during test
    if (task?.id) {
      await callWorkerApi("update", {
        task_id: task.id,
        status: "queued",
        output: null,
        error: null,
      });
      log("info", "Worker-api connection successful (claimed+returned 1 task)", {
        taskId: task.id,
      });
    } else {
      log("info", "Worker-api connection successful (no task available)", {});
    }

    return true;
  } catch (e) {
    log("error", "Failed to connect to worker-api", { error: e.message });
    return false;
  }
}

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log("info", `Received ${signal}, shutting down gracefully`);

  const check = () => {
    if (activeRenders <= 0) {
      log("info", "All renders complete, exiting");
      process.exit(0);
    }
    setTimeout(check, 1000);
  };
  check();
}

async function main() {
  log("info", "Starting render worker", {
    workerId: WORKER_ID,
    apiUrl: WORKER_API_URL,
    concurrency: CONCURRENCY,
    pollInterval: POLL_INTERVAL_MS,
    maxAttempts: MAX_ATTEMPTS,
    renderTimeout: RENDER_TIMEOUT_MS,
  });

  const ok = await testConnection();
  if (!ok) {
    console.error("\n❌ Cannot connect to worker-api. Check:");
    console.error("  1) WORKER_API_URL is correct");
    console.error("  2) WORKER_API_KEY matches the Lovable secret");
    console.error("  3) worker-api edge function is deployed\n");
    return; // don't hard-exit (prevents Windows UV_HANDLE_CLOSING assertion)
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  pollLoop();
}

main().catch((e) => {
  log("error", "Fatal error", { error: e.message });
  process.exit(1);
});
