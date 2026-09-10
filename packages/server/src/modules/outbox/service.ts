import * as repo from "@pstack/database/modules/outbox/repository";

export async function listOutboxEvents() {
  return repo.getOutboxEvents();
}
