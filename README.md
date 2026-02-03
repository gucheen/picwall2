# PicWall2 Development Guide

This guide describes how to set up and develop the PicWall2 project locally.

## Prerequisites

- **Bun**: This project uses [Bun](https://bun.sh) as the runtime and package manager. Ensure you have the latest version installed.
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```

## Getting Started

1. **Install Dependencies**

   ```bash
   bun install
   ```

2. **Environment Configuration**

   Copy the example environment file and configure it:

   ```bash
   cp .env.example .env.local
   ```
   
   Open `.env.local` and fill in the required values:
   - `POCKETID_CLIENT_ID`: Your PocketID Client ID
   - `POCKETID_CLIENT_SECRET`: Your PocketID Client Secret
   - `POCKETID_ISSUER`: PocketID Issuer URL
   - `ADMIN_EMAIL`: Your admin email address

3. **Run Development Server**

   Start the development server with hot reloading (backend):

   ```bash
   bun run dev
   ```

   The server will be running at [http://localhost:3000](http://localhost:3000).

## Project Structure

- `src/backend`: Hono server and API code.
- `src/frontend`: React frontend code.
- `public`: Static assets (uploads, thumbnails).
- `package.json`: Project scripts and dependencies.

## Commands

- `bun run dev`: Start development server (watch mode).
- `bun start`: Start production server.
