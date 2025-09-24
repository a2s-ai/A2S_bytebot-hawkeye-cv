import { ClickContext } from '@bytebot/shared';
import { Logger } from '@nestjs/common';
import {
  Coordinates,
  ScreenshotCustomRegionOptions,
  ScreenshotFnOptions,
  ScreenshotResponse,
  SmartClickAI,
} from '../agent/smart-click.types';
import { Calibrator } from './calibrator';
import { CoordinateTeacher } from './coordinate-teacher';
import {
  CoordinateParser,
  ParsedCoordinateResponse,
  evaluateCoordinateSuspicion,
} from './coordinate-parser';

export interface UniversalCoordinateStep {
  id: string;
  label: string;
  prompt: string;
  response: ParsedCoordinateResponse;
  raw: string;
  screenshot: ScreenshotResponse;
}

export interface UniversalCoordinateResult {
  coordinates: Coordinates;
  baseCoordinates: Coordinates;
  context: Omit<ClickContext, 'targetDescription' | 'source' | 'clickTaskId'>;
  steps: UniversalCoordinateStep[];
  appliedOffset: Coordinates | null;
  calibrationHistory: ReturnType<Calibrator['getHistory']>;
  confidence: number | null;
  reasoning: string | null;
}

export interface UniversalRefinerOptions {
  gridSizeHint?: number;
  progress?: {
    taskId?: string;
    fullStep?: { step: number; message: string };
    zoomStep?: { step: number; message: string };
  };
}

interface Dimension {
  width: number;
  height: number;
}

const DEFAULT_CANVAS_DIMENSIONS: Dimension = { width: 1920, height: 1080 };

export class UniversalCoordinateRefiner {
  private readonly logger = new Logger(UniversalCoordinateRefiner.name);
  private readonly debugEnabled =
    (process.env.BYTEBOT_COORDINATE_DEBUG ?? 'false').toLowerCase() === 'true';

  constructor(
    private readonly ai: SmartClickAI,
    private readonly teacher: CoordinateTeacher,
    private readonly parser: CoordinateParser,
    private readonly calibrator: Calibrator,
    private readonly capture: {
      full: (options: ScreenshotFnOptions) => Promise<ScreenshotResponse>;
      zoom: (
        options: ScreenshotCustomRegionOptions,
      ) => Promise<ScreenshotResponse>;
    },
  ) {}

  async locate(
    targetDescription: string,
    options: UniversalRefinerOptions = {},
  ): Promise<UniversalCoordinateResult> {
    const steps: UniversalCoordinateStep[] = [];
    const gridSize = options.gridSizeHint ?? 100;

    const fullScreenshot = await this.capture.full({
      gridOverlay: true,
      gridSize,
      highlightRegions: true,
      showCursor: true,
      progressStep: options.progress?.fullStep?.step,
      progressMessage: options.progress?.fullStep?.message,
      progressTaskId: options.progress?.taskId,
    });

    this.calibrator.recordTelemetry(fullScreenshot.offset, 'full-screenshot');
    const dimensions = this.getDimensions(fullScreenshot.image);

    const fullPrompt = this.teacher.buildFullFramePrompt({
      targetDescription,
      offsetHint: this.calibrator.getCurrentOffset(),
    });

    const fullRaw = await this.ai.askAboutScreenshot(
      fullScreenshot.image,
      fullPrompt,
    );
    this.debug('Full frame AI response received', {
      step: 'full-frame',
      raw: this.sanitizeForLog(fullRaw),
    });
    const fullParsed = this.parser.parse(fullRaw);
    const suspicion = evaluateCoordinateSuspicion(fullParsed, {
      dimensions: dimensions ?? undefined,
    });
    this.debug('Full frame AI response parsed', {
      step: 'full-frame',
      global: fullParsed.global,
      local: fullParsed.local,
      needsZoom: fullParsed.needsZoom ?? null,
      suspicion,
    });

    if (suspicion.suspicious) {
      fullParsed.needsZoom = true;
      const suspicionNote = `Zoom recommended: ${suspicion.reasons.join(' ')}`;
      fullParsed.reasoning = fullParsed.reasoning
        ? `${fullParsed.reasoning} ${suspicionNote}`
        : suspicionNote;
    }

    steps.push({
      id: 'full-frame',
      label: 'Full frame analysis',
      prompt: fullPrompt,
      response: fullParsed,
      raw: fullRaw,
      screenshot: fullScreenshot,
    });

    let bestGlobal = fullParsed.global ?? null;
    let needsZoom = fullParsed.needsZoom ?? !bestGlobal;
    if (suspicion.suspicious) {
      needsZoom = true;
    }

    let zoomStep: UniversalCoordinateStep | null = null;

    if (needsZoom || !bestGlobal) {
      const zoomRegion = this.resolveZoomRegion(fullParsed, dimensions);

      const zoomScreenshot = await this.capture.zoom({
        ...zoomRegion,
        gridSize: Math.max(20, Math.round(gridSize / 2)),
        zoomLevel: 2,
        showCursor: true,
        progressStep: options.progress?.zoomStep?.step,
        progressMessage: options.progress?.zoomStep?.message,
        progressTaskId: options.progress?.taskId,
      });

      this.calibrator.recordTelemetry(zoomScreenshot.offset, 'zoom-screenshot');

      const zoomPrompt = this.teacher.buildZoomPrompt({
        targetDescription,
        region: zoomRegion,
        zoomLevel: zoomScreenshot.zoomLevel ?? 2,
        offsetHint: this.calibrator.getCurrentOffset(),
        fallbackGlobal: bestGlobal ?? undefined,
      });

      const zoomRaw = await this.ai.askAboutScreenshot(
        zoomScreenshot.image,
        zoomPrompt,
      );
      this.debug('Zoom AI response received', {
        step: 'zoom-refine',
        raw: this.sanitizeForLog(zoomRaw),
      });
      const zoomParsed = this.parser.parse(zoomRaw);
      this.debug('Zoom AI response parsed', {
        step: 'zoom-refine',
        global: zoomParsed.global,
        local: zoomParsed.local,
        needsZoom: zoomParsed.needsZoom ?? null,
      });

      zoomStep = {
        id: 'zoom-refine',
        label: 'Zoom refinement',
        prompt: zoomPrompt,
        response: zoomParsed,
        raw: zoomRaw,
        screenshot: zoomScreenshot,
      };
      steps.push(zoomStep);

      if (zoomParsed.global) {
        bestGlobal = zoomParsed.global;
        needsZoom = false;
      } else if (zoomParsed.local) {
        const anchor = this.resolveZoomAnchor(zoomScreenshot, zoomRegion);
        bestGlobal = {
          x: Math.round(anchor.x + zoomParsed.local.x),
          y: Math.round(anchor.y + zoomParsed.local.y),
        };
        needsZoom = false;
      }
    }

    if (!bestGlobal) {
      throw new Error(
        'Universal coordinate refiner could not obtain global coordinates.',
      );
    }

    const currentOffset = this.calibrator.getCurrentOffset();
    const adjusted = this.calibrator.apply(bestGlobal);

    const bounds = dimensions ?? DEFAULT_CANVAS_DIMENSIONS;
    const maxX = Math.max(0, bounds.width - 1);
    const maxY = Math.max(0, bounds.height - 1);
    const clamped = {
      x: Math.min(maxX, Math.max(0, adjusted.x)),
      y: Math.min(maxY, Math.max(0, adjusted.y)),
    };

    let appliedOffset = currentOffset;
    if (
      appliedOffset &&
      (clamped.x !== adjusted.x || clamped.y !== adjusted.y)
    ) {
      appliedOffset = {
        x: clamped.x - bestGlobal.x,
        y: clamped.y - bestGlobal.y,
      };
    }

    this.debug('Coordinate calibration applied', {
      original: bestGlobal,
      offset: currentOffset,
      adjusted,
      final: clamped,
    });

    const context: UniversalCoordinateResult['context'] = {
      region: zoomStep?.screenshot.region ?? undefined,
      zoomLevel: zoomStep?.screenshot.zoomLevel ?? 1,
    };

    return {
      coordinates: clamped,
      baseCoordinates: bestGlobal,
      context,
      steps,
      appliedOffset,
      calibrationHistory: this.calibrator.getHistory(),
      confidence:
        zoomStep?.response.confidence ?? steps[0]?.response.confidence ?? null,
      reasoning:
        zoomStep?.response.reasoning ?? steps[0]?.response.reasoning ?? null,
    };
  }

  private resolveZoomRegion(
    parsed: ParsedCoordinateResponse,
    dims: Dimension | null,
  ): { x: number; y: number; width: number; height: number } {
    const fallbackWidth = dims
      ? Math.max(280, Math.round(dims.width / 3))
      : 400;
    const fallbackHeight = dims
      ? Math.max(220, Math.round(dims.height / 3))
      : 300;

    const zoom = parsed.zoom;
    const region = zoom?.region;

    const regionDerivedCenter = region
      ? {
          x: region.x + region.width / 2,
          y: region.y + region.height / 2,
        }
      : null;

    const center =
      zoom?.center ??
      regionDerivedCenter ??
      parsed.global ??
      (dims ? { x: dims.width / 2, y: dims.height / 2 } : { x: 960, y: 540 });

    const diameter =
      typeof zoom?.radius === 'number' ? Math.max(0, zoom.radius * 2) : null;

    let width = region?.width ?? null;
    let height = region?.height ?? null;

    if (diameter !== null) {
      if (width === null) {
        width = dims ? Math.min(diameter, dims.width) : diameter;
      }
      if (height === null) {
        height = dims ? Math.min(diameter, dims.height) : diameter;
      }
    }

    width = width ?? fallbackWidth;
    height = height ?? fallbackHeight;

    width = Math.max(1, width);
    height = Math.max(1, height);

    if (dims) {
      width = Math.min(width, dims.width);
      height = Math.min(height, dims.height);
    }

    const rect = {
      x: Math.max(0, Math.round(center.x - width / 2)),
      y: Math.max(0, Math.round(center.y - height / 2)),
      width: Math.round(width),
      height: Math.round(height),
    };

    if (dims) {
      rect.x = Math.min(rect.x, Math.max(0, dims.width - rect.width));
      rect.y = Math.min(rect.y, Math.max(0, dims.height - rect.height));
    }

    return rect;
  }

  private resolveZoomAnchor(
    screenshot: ScreenshotResponse,
    requested: { x: number; y: number; width: number; height: number },
  ): Coordinates {
    if (screenshot.offset) {
      return screenshot.offset;
    }
    if (screenshot.region) {
      return { x: screenshot.region.x, y: screenshot.region.y };
    }
    return { x: requested.x, y: requested.y };
  }

  private getDimensions(image: string): Dimension | null {
    try {
      const buf = Buffer.from(image, 'base64');
      if (buf.length < 24) {
        return null;
      }
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        return null;
      }
      return { width, height };
    } catch {
      return null;
    }
  }

  private debug(message: string, payload?: Record<string, unknown>) {
    if (!this.debugEnabled) {
      return;
    }

    if (payload) {
      this.logger.debug(
        `${message} ${JSON.stringify(this.sanitizeForLog(payload))}`,
      );
      return;
    }

    this.logger.debug(message);
  }

  private sanitizeForLog(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value.length > 300) {
        return `${value.slice(0, 300)}… [${value.length - 300} more chars masked]`;
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeForLog(item));
    }

    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).reduce<
        Record<string, unknown>
      >((acc, [key, val]) => {
        acc[key] = this.sanitizeForLog(val);
        return acc;
      }, {});
    }

    return value;
  }
}
