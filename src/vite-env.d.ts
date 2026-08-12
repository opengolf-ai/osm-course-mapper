/// <reference types="vite/client" />

/*
 * Pulls in Vite's ambient declarations, including the one that makes `*.css` a
 * valid module specifier. `src/map/BaseMap.tsx` imports MapLibre's stylesheet
 * lazily alongside the library itself, and TypeScript needs to know that is a
 * module rather than a missing file.
 */
