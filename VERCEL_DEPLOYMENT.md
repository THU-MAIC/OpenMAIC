# Vercel Deployment Guide

This guide walks you through deploying OpenMAIC to [Vercel](https://vercel.com/).

## Prerequisites

- A GitHub account with the OpenMAIC repository
- A Vercel account (free tier is sufficient to get started)
- At least one LLM API key (OpenAI, Anthropic, Google, etc.)

## Option 1: One-Click Deployment (Recommended)

The easiest way to deploy OpenMAIC is using the Vercel deployment button:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FTHU-MAIC%2FOpenMAIC&envDescription=Configure%20at%20least%20one%20LLM%20provider%20API%20key%20(e.g.%20OPENAI_API_KEY%2C%20ANTHROPIC_API_KEY).%20All%20providers%20are%20optional.&envLink=https%3A%2F%2Fgithub.com%2FTHU-MAIC%2FOpenMAIC%2Fblob%2Fmain%2F.env.example&project-name=openmaic&framework=nextjs)

### Steps:

1. **Click the Deploy Button** above
2. **Authorize Vercel** to access your GitHub account (if not already connected)
3. **Configure Environment Variables**:
   - Add at least one LLM provider API key (see [Supported Providers](#supported-providers))
   - Other variables are optional
4. **Click Deploy** and wait for the deployment to complete (typically 3-5 minutes)

Once deployment finishes, Vercel will provide you with a live URL to access your OpenMAIC instance.

## Option 2: Manual Deployment via Vercel Dashboard

If the one-click deployment doesn't work for your use case:

### 1. Fork the Repository

Visit [OpenMAIC on GitHub](https://github.com/THU-MAIC/OpenMAIC) and fork the repository to your GitHub account.

### 2. Create a Vercel Project

1. Go to [vercel.com/new](https://vercel.com/new)
2. Log in with your GitHub account
3. Click **Import Project**
4. Select **Import Git Repository**
5. Enter your forked repository URL and click **Continue**

### 3. Configure Build Settings

Vercel will auto-detect Next.js. Confirm:

- **Framework Preset**: Next.js
- **Build Command**: `pnpm build`
- **Output Directory**: `.next`
- **Install Command**: `pnpm install`

### 4. Set Environment Variables

1. Click **Environment Variables**
2. Add the following variables (minimum required):
   - **LLM Provider**: At least one of:
     - `OPENAI_API_KEY`
     - `ANTHROPIC_API_KEY`
     - `GOOGLE_API_KEY`
     - etc. (see [Supported Providers](#supported-providers))
   
3. (Optional) Add other variables from `.env.example`

### 5. Deploy

Click **Deploy** and wait for the build and deployment to complete.

## Environment Variables

### Minimum Required

You need **at least one LLM provider API key**. Choose your preferred provider:

```env
OPENAI_API_KEY=sk-...
# OR
ANTHROPIC_API_KEY=sk-ant-...
# OR
GOOGLE_API_KEY=...
```

### Supported Providers

| Provider | Variable | Format |
|----------|----------|--------|
| OpenAI | `OPENAI_API_KEY` | `sk-...` |
| Anthropic | `ANTHROPIC_API_KEY` | `sk-ant-...` |
| Google Gemini | `GOOGLE_API_KEY` | `...` |
| DeepSeek | `DEEPSEEK_API_KEY` | `...` |
| Grok (xAI) | `GROK_API_KEY` | `xai-...` |
| MiniMax | `MINIMAX_API_KEY` | `...` |
| Qwen | `QWEN_API_KEY` | `...` |
| Kimi | `KIMI_API_KEY` | `...` |
| GLM (Zhipu) | `GLM_API_KEY` | `...` |
| OpenAI-Compatible | Custom | See below |

For each provider, you can optionally configure:
- `{PROVIDER}_BASE_URL` - Custom API endpoint
- `{PROVIDER}_MODELS` - Comma-separated model list

For OpenAI-compatible APIs (e.g., MiniMax, DeepSeek):

```env
MINIMAX_API_KEY=...
MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic/v1
DEFAULT_MODEL=minimax:MiniMax-M2.7-highspeed
```

### Optional Variables

See the full list in [`.env.example`](.env.example):

- **Text-to-Speech (TTS)**:
  - `TTS_PROVIDER` (e.g., `elevenlabs`, `google`, `azure`)
  - `TTS_ELEVENLABS_API_KEY`
  
- **Image Generation**:
  - `IMAGE_PROVIDER` (e.g., `openai`, `stability`)
  - `IMAGE_STABILITY_API_KEY`

- **PDF Parsing**:
  - `PDF_MINERU_BASE_URL` (MinerU API or self-hosted instance)
  - `PDF_MINERU_API_KEY` (if required)

- **Web Search**:
  - `JINA_API_KEY` (for web search via Jina)

- **Advanced**:
  - `DEFAULT_MODEL` - Default LLM model to use (e.g., `google:gemini-3-flash-preview`)
  - `MAX_TOKENS` - Maximum tokens per response

## After Deployment

### 1. Access Your Instance

Once deployment is complete, Vercel will provide a URL. Click it to access your OpenMAIC instance.

### 2. Enable Automatic Deployments

Your Vercel project is automatically connected to your GitHub fork. Every push to the `main` branch will trigger a new deployment.

To update OpenMAIC with upstream changes:

```bash
# Add upstream remote (if not already done)
git remote add upstream https://github.com/THU-MAIC/OpenMAIC.git

# Fetch and merge upstream
git fetch upstream main
git merge upstream/main

# Push to your fork
git push origin main
```

Vercel will automatically deploy the updated code.

### 3. Configure Domain (Optional)

To use a custom domain:

1. Go to your Vercel project settings
2. Click **Domains**
3. Add your domain and follow the DNS configuration instructions

## Troubleshooting

### Build Fails

**Error**: `ERR! 404 Not Found`

**Solution**: Ensure pnpm is properly installed. Check that your package manager version is correct:

```
pnpm@10.28.0+sha512...
```

This is specified in `package.json` and Vercel respects it.

### API Keys Not Working

1. Verify environment variables are set in Vercel dashboard
2. Ensure variable names match exactly (case-sensitive)
3. Redeploy after updating variables

**Note**: Environment variables set after initial deployment require a redeploy to take effect.

### High Build Times

OpenMAIC includes workspace packages (mathml2omml, pptxgenjs) that compile during build.

- Build time: 2-4 minutes (typical)
- First build: 4-6 minutes (due to dependency installation)

This is normal. To optimize, ensure:
- No large uncommitted files in the repository
- Dependencies are pinned in `package.json`

### Runtime Issues

**Error**: `Module not found: Can't resolve...`

**Solution**: The postinstall script builds workspace packages. Ensure this runs successfully:

1. Check Vercel build logs
2. Verify all dependencies are listed in `package.json`
3. Check that no files were excluded in `.vercelignore`

## Features After Deployment

Your deployed OpenMAIC instance includes:

- ✅ Full lesson generation pipeline
- ✅ Multi-agent classroom
- ✅ Slides, quizzes, interactive simulations, PBL
- ✅ Whiteboard & TTS (if configured)
- ✅ Export to PowerPoint and HTML
- ✅ Dark mode & i18n (Chinese & English)

## Performance & Limits

- **Free Tier**: 
  - Deployments: Unlimited
  - Build minutes: 6000/month
  - Bandwidth: 100GB/month
  - Function duration: 10 seconds max

- **Pro Tier** (recommended for production):
  - Function duration: 60 seconds (OpenMAIC API routes need up to 5 minutes)
  - Unlimited bandwidth
  - Priority support

**Note**: The vercel.json file configures function timeout to 300 seconds (5 minutes) for `/api/**` routes. This requires a paid plan. For the free tier, keep function executions under 10 seconds.

## Continuous Deployment

Every push to your GitHub fork's `main` branch triggers a Vercel deployment:

```bash
git push origin main  # Triggers automatic deployment
```

To deploy from a different branch:

1. Go to Vercel project settings
2. Click **Git**
3. Change **Production Branch**

## Getting Help

- **Documentation**: See [README.md](README.md)
- **Issues**: [GitHub Issues](https://github.com/THU-MAIC/OpenMAIC/issues)
- **Discord**: [Join Community](https://discord.gg/PtZaaTbH)

## Next Steps

After deployment:

1. ✅ Add at least one LLM provider API key
2. ✅ Visit your deployed instance
3. ✅ Try generating a lesson (e.g., "Teach me Python from scratch")
4. ✅ Explore settings for TTS, image generation, etc.
5. ✅ Join the community for discussions and updates

Happy learning! 🚀
