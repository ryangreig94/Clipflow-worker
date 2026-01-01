# ClipFlow Render Worker

External FFmpeg worker that processes render tasks from the ClipFlow queue.

## Prerequisites

- Node.js 18+
- FFmpeg installed (`ffmpeg -version`)

## Quick Start

### 1. Get Credentials from Lovable Cloud Backend

1. In Lovable, click the **"View Backend"** button
2. Navigate to **Settings → API Keys**
3. Copy the **service_role** key (not the anon key)

Your Supabase URL is: `https://jnrpgmdqqfojnsctvdnc.supabase.co`

### 2. Configure Environment

```bash
cd worker
npm install

# Create .env file
cat > .env << EOF
SUPABASE_URL=https://jnrpgmdqqfojnsctvdnc.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
EOF
```

### 3. Run the Worker

```bash
npm start
```

You should see:
```
{"level":"info","worker":"worker-abc123","message":"Worker started"}
{"level":"info","worker":"worker-abc123","message":"Processing task","taskId":"..."}
```

## Docker

```bash
docker build -t clipflow-render-worker .

docker run -d \
  --name render-worker \
  -e SUPABASE_URL=https://jnrpgmdqqfojnsctvdnc.supabase.co \
  -e SUPABASE_SERVICE_ROLE_KEY=your-key \
  clipflow-render-worker
```

### Docker Compose

```yaml
version: '3.8'
services:
  render-worker:
    build: ./worker
    restart: unless-stopped
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
      - CONCURRENCY=4
      - WORKER_ID=worker-1
```

## Deployment Options

### Render.com

1. Create a new "Background Worker" service
2. Connect your repo, set root directory to `worker`
3. Set environment variables
4. Deploy

### Fly.io

```bash
cd worker
fly launch --no-deploy
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
fly deploy
```

### Hetzner/VPS

```bash
# On your VPS
git clone your-repo
cd your-repo/worker
npm install

# Use PM2 for process management
npm install -g pm2
pm2 start render-worker.js --name clipflow-worker
pm2 save
pm2 startup
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | ✅ | - | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | - | Service role key (has bypass RLS) |
| `STORAGE_BUCKET` | ❌ | `clipflow` | Storage bucket for rendered files |
| `WORKER_ID` | ❌ | `worker-{random}` | Unique worker identifier |
| `POLL_INTERVAL_MS` | ❌ | `5000` | How often to poll for tasks |
| `CONCURRENCY` | ❌ | `2` | Max concurrent renders |
| `MAX_ATTEMPTS` | ❌ | `3` | Max retry attempts per task |
| `RENDER_TIMEOUT_MS` | ❌ | `300000` | Render timeout (5 min) |

## How It Works

1. **Poll**: Worker calls `claim_render_task` RPC to atomically claim one task
2. **Download**: Resolves Twitch clip URL and downloads to temp file
3. **Render**: Runs FFmpeg with trim, filter_complex, and output args from task
4. **Upload**: Uploads rendered MP4 to `renders/{user_id}/{job_id}/{clip_index}_{template}.mp4`
5. **Update**: Marks task as done, increments job progress counter
6. **Finalize**: When all tasks complete, fetches original pack, attaches render URLs, uploads new pack

## Output Structure

```
clipflow/
├── renders/
│   └── {user_id}/
│       └── {job_id}/
│           ├── 0_top_white_box.mp4
│           ├── 1_full_screen_statement.mp4
│           ├── 2_double_caption.mp4
│           └── rendered-pack.json
```

## Troubleshooting

### No tasks being claimed
- Check `render_tasks` table has rows with `status='queued'`
- Verify `SUPABASE_SERVICE_ROLE_KEY` has correct permissions

### FFmpeg errors
- Ensure FFmpeg is installed: `ffmpeg -version`
- Check filter_complex syntax in task input

### Twitch clips not downloading
- The worker uses public Twitch GQL endpoint
- Some clips may be deleted or unavailable

## Scaling

Run multiple workers with unique WORKER_ID:

```bash
WORKER_ID=worker-1 node render-worker.js &
WORKER_ID=worker-2 node render-worker.js &
```

The atomic claiming ensures no double-processing.
