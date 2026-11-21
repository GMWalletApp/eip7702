import { setTimeout as delay } from "node:timers/promises";
import { isHash, keccak256, parseTransaction, type Address, type Hash, type Hex } from "viem";
import { assertExpectedChainId } from "./chain-guard.js";
import { networkEnv } from "./env-helpers.js";

type Submission = { hash: Hash; blockHash?: Hash };

type BroadcastActions = {
  sendDirect: () => Promise<Hash>;
  sign: (nonce: number) => Promise<Hex>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function readResponse(response: Response) {
  return asRecord(await response.json().catch(() => undefined));
}

type RelayerRoute = {
  chainId: number;
  sender: Address;
  nonce: number;
  endpoint: string;
  headers: { Authorization: string; "Content-Type": string };
};

export async function prepareRelayerRoute(prefix: string, chainId: number, sender: Address): Promise<RelayerRoute | undefined> {
  assertExpectedChainId(prefix, chainId);
  const url = networkEnv(prefix, "BROADCASTER_URL");
  const token = networkEnv(prefix, "BROADCASTER_TOKEN");
  if (!url && !token) return undefined;
  if (!url || !token) throw new Error("Configure both BROADCASTER_URL and BROADCASTER_TOKEN");

  const base = new URL(url);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Expected an HTTP(S) Broadcaster base URL without credentials, query or fragment");
  }
  const endpoint = base.href.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const response = await fetch(`${endpoint}/accounts/${sender}/nonce?chainId=${chainId}`, {
    headers, redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  const view = await readResponse(response);
  if (!response.ok) throw new Error(`Broadcaster nonce query failed (HTTP ${response.status})`);
  if (view?.chainId !== String(chainId) || typeof view.address !== "string" || view.address.toLowerCase() !== sender.toLowerCase()
    || view.blockTag !== "latest" || typeof view.chainNonce !== "string" || !/^(0|[1-9][0-9]*)$/.test(view.chainNonce)
    || typeof view.nonce !== "string" || !/^(0|[1-9][0-9]*)$/.test(view.nonce)) {
    throw new Error("Invalid queue-aware Broadcaster nonce response");
  }
  const nonce = Number(view.nonce);
  if (!Number.isSafeInteger(nonce) || BigInt(view.nonce) < BigInt(view.chainNonce)) {
    throw new Error("Broadcaster nonce is outside the supported signing range");
  }
  return { chainId, sender, nonce, endpoint: endpoint + "/transactions", headers };
}

// EIP-7702 increments the outer sender first. A distinct user's authorization
// continues to use that user's RPC nonce independently of the sponsor queue.
export function selfAuthorizationNonce(route: RelayerRoute | undefined, authority: Address): number | undefined {
  if (!route || route.sender.toLowerCase() !== authority.toLowerCase()) return undefined;
  if (!Number.isSafeInteger(route.nonce + 1)) throw new Error("Authorization nonce exceeds the supported signing range");
  return route.nonce + 1;
}

export async function sendRelayerTransaction(route: RelayerRoute | undefined, actions: BroadcastActions): Promise<Submission> {
  if (!route) {
    const hash = await actions.sendDirect();
    console.log(`tx: ${hash}`);
    return { hash };
  }
  const { chainId, endpoint, headers, nonce } = route;
  const raw = await actions.sign(nonce);
  const signed = parseTransaction(raw);
  if (signed.chainId !== chainId || signed.nonce !== nonce) throw new Error("Signed chain ID or nonce mismatch");
  const hash = keccak256(raw);
  const statusURL = `${endpoint}/${hash}?chainId=${chainId}`;
  // Print the identifier even if the process is interrupted during the POST.
  console.log(`signed tx hash: ${hash}`);
  let response: Response | undefined;
  try {
    response = await fetch(`${endpoint}?chainId=${chainId}`, {
      method: "POST", headers, body: JSON.stringify({ rawTransaction: raw }),
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A lost acknowledgement can follow a committed intake. Query the local hash.
  }
  if (response && response.status >= 400 && response.status < 500 && response.status !== 408) {
    const failure = await readResponse(response);
    const code = typeof failure?.error === "string" && /^[A-Z_]{1,64}$/.test(failure.error) ? failure.error : "REQUEST_REJECTED";
    throw new Error(`Broadcaster rejected ${hash}: HTTP ${response.status} ${code}`);
  }
  console.log(`tx: ${hash}`); // The canary treats an ambiguous send as unconfirmed.
  if (response?.ok) {
    const ack = await readResponse(response);
    if (ack?.network !== String(chainId) || ack?.txHash !== hash || !ack.taskId) {
      console.warn("Unverified submission acknowledgement; checking the locally signed hash.");
    }
  } else {
    await response?.body?.cancel().catch(() => {});
  }

  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const status = await fetch(statusURL, {
      headers, redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, until - Date.now()))),
    }).catch(() => undefined);
    if (status?.ok) {
      const task = await readResponse(status);
      if (task && (task.queriedHash !== hash || task.network !== String(chainId))) {
        throw new Error(`Broadcaster returned a different task for ${hash}`);
      }
      if (task?.taskState === "CLOSED") {
        if (task.taskOutcome !== "INCLUDED") throw new Error(`Broadcaster closed ${hash}: ${task.taskOutcome}`);
        if (task.winningHash !== hash) {
          throw new Error(`Broadcaster included replacement ${task.winningHash}; reconcile it before crediting ${hash}`);
        }
        const blockHash = asRecord(task.evidence)?.blockHash;
        if (typeof blockHash !== "string" || !isHash(blockHash)) throw new Error(`Missing inclusion block for ${hash}`);
        return { hash, blockHash };
      }
    } else if (status) {
      await status.body?.cancel().catch(() => {});
      if ([401, 403].includes(status.status)) {
        throw new Error(`Broadcaster status access denied for ${hash} (HTTP ${status.status})`);
      }
    }
    await delay(Math.min(1_500, Math.max(0, until - Date.now())));
  }
  throw new Error(`Unconfirmed transaction ${hash}. Check its Broadcaster task before starting another payment.`);
}

export function verifyRelayerReceipt(
  submitted: Submission, receipt: { transactionHash: Hash; blockHash: Hash },
) {
  if (submitted.blockHash && (receipt.transactionHash !== submitted.hash || receipt.blockHash !== submitted.blockHash)) {
    throw new Error(`RPC receipt disagrees with Broadcaster inclusion for ${submitted.hash}; reconcile before crediting`);
  }
}
