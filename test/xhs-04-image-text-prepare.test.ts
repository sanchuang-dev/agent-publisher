import { describe, expect, test } from "vitest";
import type { Page } from "playwright";

import {
  prepareXiaohongshuPublication,
} from "../src/platforms/xiaohongshu/image-text-prepare.js";
import { createImageTextMaterialPackFixture } from "../src/materials/testing/fake-providers.js";

type LocatorKind =
  | "entry"
  | "upload"
  | "uploaded"
  | "title"
  | "body"
  | "tags"
  | "upload_failure"
  | "upload_busy"
  | "none";

interface FakeCreatorState {
  entered: boolean;
  uploadedPaths: string[];
  title: string;
  body: string;
  events: string[];
}

class FakeLocator {
  constructor(
    private readonly state: FakeCreatorState,
    private readonly kinds: readonly LocatorKind[],
  ) {}

  or(other: FakeLocator): FakeLocator {
    return new FakeLocator(this.state, [...this.kinds, ...other.kinds]);
  }

  first(): FakeLocator {
    return this;
  }

  nth(index: number): FakeLocator {
    let offset = index;
    for (const kind of this.kinds) {
      const count = this.countFor(kind);
      if (offset < count) {
        return new FakeLocator(this.state, [kind]);
      }
      offset -= count;
    }
    return new FakeLocator(this.state, ["none"]);
  }

  async count(): Promise<number> {
    return this.activeKinds().reduce(
      (total, kind) => total + this.countFor(kind),
      0,
    );
  }

  async isVisible(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  async waitFor(): Promise<void> {
    if ((await this.count()) === 0) {
      throw new Error("fixture locator is not available yet");
    }
  }

  async click(): Promise<void> {
    if (!this.kinds.includes("entry")) {
      throw new Error("fixture attempted to click a non-entry locator");
    }
    this.state.entered = true;
    this.state.events.push("enter_image_text");
  }

  async setInputFiles(files: string | readonly string[]): Promise<void> {
    if (!this.kinds.includes("upload") || !this.state.entered) {
      throw new Error("fixture upload input is not ready");
    }
    const incoming = typeof files === "string" ? [files] : [...files];
    this.state.uploadedPaths.push(...incoming);
    this.state.events.push("upload");
  }

  async fill(value: string): Promise<void> {
    if (this.kinds.includes("title")) {
      this.state.title = value;
      this.state.events.push("fill_title");
      return;
    }
    if (this.kinds.includes("body")) {
      this.state.body = value;
      this.state.events.push("fill_body");
      return;
    }
    throw new Error("fixture attempted to fill an unsupported locator");
  }

  async evaluate<T>(): Promise<T> {
    if (this.kinds.includes("title")) return this.state.title as T;
    if (this.kinds.includes("body")) return this.state.body as T;
    return "" as T;
  }

  private activeKinds(): readonly LocatorKind[] {
    return this.kinds.filter((kind) => this.countFor(kind) > 0);
  }

  private countFor(kind: LocatorKind): number {
    switch (kind) {
      case "entry":
        return 1;
      case "upload":
        return this.state.entered ? 1 : 0;
      case "uploaded":
        return this.state.uploadedPaths.length;
      case "title":
      case "body":
        return this.state.uploadedPaths.length > 0 ? 1 : 0;
      case "tags":
      case "upload_failure":
      case "upload_busy":
      case "none":
        return 0;
    }
  }
}

class FakeCreatorPage {
  readonly state: FakeCreatorState = {
    entered: false,
    uploadedPaths: [],
    title: "",
    body: "",
    events: [],
  };

  url(): string {
    return "https://creator.xiaohongshu.com/publish/publish?source=official&token=must-not-surface";
  }

  getByRole(): FakeLocator {
    return new FakeLocator(this.state, ["entry"]);
  }

  getByText(text: string | RegExp): FakeLocator {
    if (text === "上传图文") {
      return new FakeLocator(this.state, ["entry"]);
    }
    const source = text instanceof RegExp ? text.source : text;
    if (/上传失败|上传错误|处理失败/.test(source)) {
      return new FakeLocator(this.state, ["upload_failure"]);
    }
    if (/上传中|处理中|正在上传|正在处理/.test(source)) {
      return new FakeLocator(this.state, ["upload_busy"]);
    }
    return new FakeLocator(this.state, ["none"]);
  }

  locator(selector: string): FakeLocator {
    if (selector.includes("creator-tab")) {
      return new FakeLocator(this.state, ["entry"]);
    }
    if (
      selector.includes("uploaded-image") ||
      selector.includes("image-preview") ||
      selector.includes("upload-item")
    ) {
      return new FakeLocator(this.state, ["uploaded"]);
    }
    if (
      selector.includes("upload-input") ||
      selector.includes('type="file"')
    ) {
      return new FakeLocator(this.state, ["upload"]);
    }
    if (selector.includes("标题")) {
      return new FakeLocator(this.state, ["title"]);
    }
    if (selector.includes("正文") || selector.includes("ProseMirror")) {
      return new FakeLocator(this.state, ["body"]);
    }
    if (selector.includes("话题") || selector.includes("标签")) {
      return new FakeLocator(this.state, ["tags"]);
    }
    return new FakeLocator(this.state, ["none"]);
  }

  async waitForTimeout(): Promise<void> {
    return;
  }
}

describe("XHS-04 current Creator image-text compatibility", () => {
  test("uploads before editor discovery and keeps empty tags a no-op without final publish", async () => {
    const basePack = createImageTextMaterialPackFixture();
    const pack = {
      ...basePack,
      copy: {
        ...basePack.copy,
        tags: [],
      },
    };
    const fake = new FakeCreatorPage();
    let mutationStarted = false;

    const prepared = await prepareXiaohongshuPublication({
      page: fake as unknown as Page,
      materialPack: pack,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      timeoutMs: 100,
      now: () => new Date("2026-09-21T10:00:00.000Z"),
      onMutationStarted: () => {
        mutationStarted = true;
        fake.state.events.push("mutation_checkpoint");
      },
    });

    expect(mutationStarted).toBe(true);
    expect(fake.state.events).toEqual([
      "enter_image_text",
      "mutation_checkpoint",
      "upload",
      "upload",
      "upload",
      "fill_title",
      "fill_body",
    ]);
    expect(fake.state.uploadedPaths).toHaveLength(3);
    expect(fake.state.title).toBe(pack.copy.title);
    expect(fake.state.body).toContain(pack.copy.body);
    expect(fake.state.events).not.toContain("final_publish");

    expect(prepared).toMatchObject({
      platform: "xiaohongshu",
      mode: "image_text",
      title: pack.copy.title,
      bodyLength: pack.copy.body.length,
      tags: pack.copy.tags,
      imageCount: 3,
    });
  });
});
