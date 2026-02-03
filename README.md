# PicWall2

A modern photo wall application built with **Node.js**, **Hono**, **React**, and **Vite**.

## Features

- **Performance**: High-speed backend with [Hono](https://hono.dev) and [Node.js](https://nodejs.org).
- **Modern Frontend**: Built with [React](https://react.dev) and [Vite](https://vitejs.dev).
- **Authentication**: Integrated with [PocketID](https://github.com/pocket-id/pocket-id) via OpenID Connect.
- **Auto-Thumbnails**: Automatic EXIF extraction and thumbnail generation using `sharp`.
- **Flexible Storage**: Supports both local filesystem and S3-compatible object storage (e.g., Cloudflare R2, AWS S3).

## Prerequisites

- **Node.js**: v20 or higher.
- **pnpm**: Recommended package manager.

## Getting Started

1. **Install Dependencies**

   ```bash
   pnpm install
   ```

2. **Environment Configuration**

   Copy the example environment file:

   ```bash
   cp .env.example .env.local
   ```

   Configure `.env.local` with your details:

   ```env
   # Authentication (PocketID)
   POCKETID_CLIENT_ID="your_client_id"
   POCKETID_CLIENT_SECRET="your_client_secret"
   POCKETID_ISSUER="https://your-pocket-id-instance.com"
   ADMIN_EMAIL="admin@example.com"

   # Storage Configuration
   # Options: 'local' (default) or 's3'
   STORAGE_TYPE="local"

   # S3 Configuration (Required if STORAGE_TYPE="s3")
   S3_ENDPOINT="https://<accountid>.r2.cloudflarestorage.com"
   S3_BUCKET="picwall-bucket"
   S3_ACCESS_KEY_ID="your_access_key"
   S3_SECRET_ACCESS_KEY="your_secret_key"
   # Optional: Public CDN URL for serving images
   S3_CDN_URL="https://cdn.example.com"
   ```

3. **Run Development Server**

   Start both backend and frontend in watch mode:

   ```bash
   npm run dev
   ```

   - Frontend: [http://localhost:5173](http://localhost:5173) (Proxies API requests to backend)
   - Backend: [http://localhost:3000](http://localhost:3000)

4. **Production Build**

   Build the frontend and server for production:

   ```bash
   npm run build
   npm start
   ```

## Project Structure

- `src/`: Frontend React application.
- `server/`: Backend Hono application.
  - `index.ts`: Server entry point.
  - `photos.ts`: Photo processing logic.
  - `storage.ts`: Storage adapters (Local/S3).
  - `auth.ts`: Authentication handlers.
- `public/`: Static assets (default local storage location).
- `dist/`: production build output.

## License

MIT
