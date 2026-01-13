# ClipFlow Workers

Background workers for processing video jobs. These run on Railway or Fly.io, separate from the Replit frontend.

## Workers

### 1. Discover Worker (`discover-worker/`)
Handles AI discovery jobs:
- Polls Supabase for `discover` jobs with status `ready`
- Searches platforms (Twitch, YouTube, Rumble) for viral content
- Creates `render_clip` jobs for each discovered clip

### 2. Render Worker (`render-worker/`)
Handles video rendering jobs:
- Claims tasks from `render_tasks` table using RPC
- Downloads source videos
- Processes with FFmpeg
- Uploads results to Supabase Storage
- Updates job status

## Setup on Railway

### 1. Create Railway Project
1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Connect your ClipFlow repository

### 2. Create Services
Create two separate services from the same repo:

#### Discover Worker Service
1. Click "New" → "Service"
2. Select your repo
3. Configure:
   - **Root Directory**: `workers`
   - **Start Command**: `npm run discover`
   - **Environment Variables**:
     ```
     SUPABASE_URL=https://your-project.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
     WORKER_ID=discover-1
     ```

#### Render Worker Service
1. Click "New" → "Service"
2. Select your repo
3. Configure:
   - **Root Directory**: `workers`
   - **Start Command**: `npm run render`
   - **Environment Variables**:
     ```
     SUPABASE_URL=https://your-project.supabase.co
     SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
     WORKER_ID=render-1
     ```

### 3. Scale Workers
For production, you can run multiple instances:
- Discover Worker: 1-2 instances (discovery is less intensive)
- Render Worker: 2-5 instances (video processing is CPU-intensive)

## Setup on Fly.io

### 1. Install Fly CLI
```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

### 2. Create Apps
```bash
cd workers

# Create discover worker app
fly apps create clipflow-discover-worker
fly secrets set SUPABASE_URL=https://your-project.supabase.co
fly secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
fly secrets set WORKER_ID=discover-fly-1

# Create render worker app
fly apps create clipflow-render-worker
fly secrets set SUPABASE_URL=https://your-project.supabase.co
fly secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
fly secrets set WORKER_ID=render-fly-1
```

### 3. Create fly.toml files
See `fly.discover.toml` and `fly.render.toml` for configuration examples.

## Local Development

### Prerequisites
- Node.js 18+
- Supabase project with tables created

### Running Locally
```bash
cd workers
npm install

# Set environment variables
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
export WORKER_ID=local-dev

# Run discover worker
npm run discover

# Or run render worker
npm run render
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (admin access) |
| `WORKER_ID` | No | Unique worker identifier (auto-generated if not set) |
| `TWITCH_CLIENT_ID` | No | For Twitch API access |
| `TWITCH_CLIENT_SECRET` | No | For Twitch API access |
| `YOUTUBE_API_KEY` | No | For YouTube API access |

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Replit App    │     │    Supabase     │
│   (Frontend)    │────▶│   (Database)    │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
              ┌─────▼─────┐ ┌────▼────┐ ┌─────▼─────┐
              │ Discover  │ │ Render  │ │ Render    │
              │ Worker    │ │ Worker  │ │ Worker    │
              │ (Railway) │ │ #1      │ │ #2        │
              └───────────┘ └─────────┘ └───────────┘
```

## Verification

### Verify Supabase Connection (Replit)
Visit `/health` endpoint to confirm database connectivity:
```bash
curl https://your-app.replit.app/health
# Expected: {"ok":true,"db":"connected","timestamp":"..."}
```

### Verify Workers Are Running (Supabase)
Check the `worker_heartbeat` table for increasing rows:
```sql
-- In Supabase SQL Editor
SELECT * FROM worker_heartbeat ORDER BY created_at DESC LIMIT 10;
```

Workers send a heartbeat every 60 seconds. If rows are increasing, workers are alive.

### Verify in Railway Logs
Railway shows live logs for each service. Look for:
- `ClipFlow Discover Worker started`
- `Heartbeat sent from discover-1`
- `Processing discover job...`

## Adding Real Platform Integration

To enable actual video discovery and processing:

### Twitch
1. Create a Twitch Developer app at dev.twitch.tv
2. Add `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`
3. Implement Twitch API calls in `discoverClips()`

### YouTube
1. Create a YouTube Data API key in Google Cloud Console
2. Add `YOUTUBE_API_KEY`
3. Implement YouTube API calls in `discoverClips()`

### FFmpeg Processing
1. Install FFmpeg in the worker environment
2. Implement video download using yt-dlp
3. Implement FFmpeg commands for video processing
4. Upload results to Supabase Storage
