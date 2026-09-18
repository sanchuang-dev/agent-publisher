export type { DesignProvider } from "./design.js";
export type { ImageProvider } from "./image.js";
export type { TextProvider } from "./text.js";
export type { VideoProvider } from "./video.js";

import type { DesignProvider } from "./design.js";
import type { ImageProvider } from "./image.js";
import type { TextProvider } from "./text.js";
import type { VideoProvider } from "./video.js";

export interface MaterialProviderSlots {
  readonly text: TextProvider;
  readonly image: ImageProvider;
  readonly design?: DesignProvider;
  readonly video?: VideoProvider;
}
