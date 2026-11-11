import type { Sim } from '../sim/sim';

/** What the browser will say about its 3D graphics: the first thing asked when the street view will not open. */
function graphicsReport(): Record<string, unknown> {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { webgl2: false, webgl1: !!canvas.getContext('webgl') };
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const report = {
      webgl2: true,
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return report;
  } catch (error) {
    return { webgl2: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Everything needed to look into a report: the release, the machine's
 * graphics, the interface state the player was in, and the city itself as it
 * would be saved. Nothing leaves the machine; the player attaches the file.
 */
export function debugReport(sim: Sim, ui: Record<string, unknown>): string {
  sim.settleDeferred();
  const w = sim.world;
  return JSON.stringify({
    kind: 'original-gangster-debug',
    version: __APP_VERSION__,
    created: new Date().toISOString(),
    browser: typeof navigator === 'undefined' ? null : {
      userAgent: navigator.userAgent, language: navigator.language,
      screen: typeof screen === 'undefined' ? null : { width: screen.width, height: screen.height, pixelRatio: window.devicePixelRatio },
      window: { width: window.innerWidth, height: window.innerHeight },
    },
    graphics: typeof document === 'undefined' ? null : graphicsReport(),
    game: { week: w.week, minute: w.minute, phase: w.phase, seed: w.options.seed, city: `${w.gridW}×${w.gridH}`, original: !!w.cityLayout?.original },
    ui,
    recentMessages: w.messages.slice(-60),
    world: w,
  });
}

/** `original-gangster-debug-v1.0.6-week3.json.gz` (or `.txt` where the browser cannot compress). */
export async function downloadDebugFile(sim: Sim, ui: Record<string, unknown>): Promise<string> {
  const text = debugReport(sim, ui);
  const base = `original-gangster-debug-v${__APP_VERSION__}-week${sim.world.week}`;
  let blob: Blob, name: string;
  if (typeof CompressionStream !== 'undefined') {
    // GitHub takes .gz attachments, and a city compresses to a fraction of its size.
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    blob = await new Response(stream).blob();
    name = `${base}.json.gz`;
  } else {
    blob = new Blob([text], { type: 'text/plain' });
    name = `${base}.txt`;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
