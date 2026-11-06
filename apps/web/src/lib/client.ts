import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { router } from "../server/rpc.ts";

export const client: RouterClient<typeof router> = createORPCClient(
  new RPCLink({
    url: () => `${window.location.origin}/rpc`,
  }),
);
