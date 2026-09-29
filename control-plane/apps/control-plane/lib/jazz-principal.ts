import { app } from "../schema";
import { jazzContext } from "./jazz-context";

/** Trusted server handle. Every caller must enforce ownerId explicitly. */
export function jazzBackendDb() {
  return jazzContext().asBackend(app);
}
