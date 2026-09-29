import { protectedResourceMetadata } from "../../../../lib/protected-resource-metadata";

export function GET() {
  return protectedResourceMetadata(false);
}

export function HEAD() {
  return protectedResourceMetadata(true);
}
