import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { savePhoto } from '../server/photos';
import { storage } from '../server/storage';

const PHOTOS_DIR = process.argv[2] || './photos';

async function main() {
    console.log(`Scanning directory: ${PHOTOS_DIR}`);

    // 1. Get existing photos from DB to avoid duplicates
    const existingPhotos = await storage.list();
    const existingIds = new Set(existingPhotos.map(p => p.id));
    console.log(`Found ${existingIds.size} existing photos in DB.`);

    // 2. Read local directory
    try {
        // Ensure directory exists
        const dirFile = Bun.file(PHOTOS_DIR);
        // Bun.file check for directory is tricky, better use readdir and catch

        let files: string[] = [];
        try {
            files = await readdir(PHOTOS_DIR);
        } catch (e) {
            console.error(`Directory not found or inaccessible: ${PHOTOS_DIR}`);
            return;
        }

        console.log(`Found ${files.length} files in directory.`);
        let importedCount = 0;
        let skippedCount = 0;

        for (const file of files) {
            // Filter image extensions
            if (!file.match(/\.(jpg|jpeg|png|gif|avif|webp)$/i)) continue;

            const filePath = path.join(PHOTOS_DIR, file);
            const fileObj = Bun.file(filePath);

            // Sanitize name to match savePhoto logic for ID generation
            const sanitizedName = file.replace(/[^a-zA-Z0-9.-]/g, '_');

            // Check DB
            if (existingIds.has(sanitizedName)) {
                // console.log(`[SKIP] Already in DB: ${file}`);
                skippedCount++;
                continue;
            }

            // Optional: Check Storage Service (to avoid re-upload if logic allows, 
            // but requirement says "process as new upload" if not present. 
            // If we interpret "not present" as "not in DB OR not in storage", 
            // and we want to recover "in storage but not DB", we still need to run savePhoto (or part of it).
            // savePhoto overwrites, which is safe for consistency.

            // Check if exists in storage (just for logging/info)
            const existsInUploads = await storage.get(sanitizedName, 'uploads');
            if (existsInUploads) {
                console.log(`[INFO] File exists in storage but not DB: ${sanitizedName}. Re-importing to fix DB.`);
            }

            console.log(`[IMPORT] Processing: ${file} -> ${sanitizedName}`);

            try {
                const buffer = await fileObj.arrayBuffer();
                const uploadFile = new File([buffer], file, { type: fileObj.type });

                await savePhoto(uploadFile);
                importedCount++;
            } catch (err) {
                console.error(`[ERROR] Failed to import ${file}:`, err);
            }
        }

        console.log('------------------------------------------------');
        console.log(`Import completed.`);
        console.log(`Skipped: ${skippedCount}`);
        console.log(`Imported: ${importedCount}`);
        console.log('------------------------------------------------');

    } catch (error) {
        console.error("Unexpected error:", error);
    }
}

main();
