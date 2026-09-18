export const publishPlatforms = [
  "xiaohongshu",
  "douyin",
  "wechat-official-account",
] as const;

export type PublishPlatform = (typeof publishPlatforms)[number];

export interface PublishJobInput {
  platform: PublishPlatform;
  title: string;
  body: string;
  mediaPaths: readonly string[];
}

export function isPublishPlatform(value: string): value is PublishPlatform {
  return publishPlatforms.includes(value as PublishPlatform);
}
