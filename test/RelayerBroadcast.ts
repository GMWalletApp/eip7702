import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, parseTransaction, type Hash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sendRelayerTransaction, verifyRelayerReceipt } from "../scripts/relayer-broadcast.js";

const blockHash: Hash = `0x${"aa".repeat(32)}`;
const otherHash: Hash = `0x${"bb".repeat(32)}`;
const sponsor = privateKeyToAccount(generatePrivateKey());
const user = privateKeyToAccount(generatePrivateKey());
const authorization = await user.signAuthorization({ chainId: 1, nonce: 0, contractAddress: sponsor.address });
const raw = await sponsor.signTransaction({
  type: "eip7702", chainId: 1, nonce: 0, to: user.address, authorizationList: [authorization],
  gas: 80_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
});
const hash = keccak256(raw);

describe("Broadcaster relayer submission", () => {
  for (const scenario of ["accepted", "lost acknowledgement", "nonce conflict", "different winner", "external consumption", "wrong network"] as const) {
    it(scenario, async (t) => {
      t.mock.method(console, "log", () => {});
      t.mock.method(console, "warn", () => {});
      const oldURL = process.env.ETHEREUM_BROADCASTER_URL;
      const oldToken = process.env.ETHEREUM_BROADCASTER_TOKEN;
      process.env.ETHEREUM_BROADCASTER_URL = "http://localhost:8080/internal/";
      process.env.ETHEREUM_BROADCASTER_TOKEN = "test-merchant";
      t.after(() => {
        if (oldURL === undefined) delete process.env.ETHEREUM_BROADCASTER_URL;
        else process.env.ETHEREUM_BROADCASTER_URL = oldURL;
        if (oldToken === undefined) delete process.env.ETHEREUM_BROADCASTER_TOKEN;
        else process.env.ETHEREUM_BROADCASTER_TOKEN = oldToken;
      });

      let sends = 0, reads = 0, signs = 0;
      t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
        assert.equal(new Headers(options.headers).get("authorization"), "Bearer test-merchant");
        assert.equal(options.redirect, "error");
        if (options.method === "POST") {
          sends++;
          assert.equal(url, "http://localhost:8080/internal/transactions?chainId=1");
          assert.deepEqual(JSON.parse(String(options.body)), { rawTransaction: raw });
          assert.equal(parseTransaction(raw).type, "eip7702");
          if (scenario === "nonce conflict") return Response.json({error:"NONCE_CONFLICT"},{status:409});
          if (scenario === "lost acknowledgement") throw new Error("lost response");
          return Response.json({ network: "1", txHash: hash, taskId: "fixture" }, {status:202});
        }
        reads++;
        assert.equal(url, `http://localhost:8080/internal/transactions/${hash}?chainId=1`);
        return Response.json({
          network: scenario === "wrong network" ? "56" : "1", queriedHash: hash, taskState: "CLOSED",
          taskOutcome: scenario === "external consumption" ? "REPLACED_EXTERNALLY" : "INCLUDED",
          winningHash: scenario === "different winner" ? otherHash : hash, evidence:{blockHash},
        });
      });
      const result = sendRelayerTransaction("ETHEREUM", 1, {
        sendDirect: () => assert.fail("unexpected RPC broadcast"),
        sign: async () => { signs++; return raw; },
      });
      if (scenario === "accepted" || scenario === "lost acknowledgement") {
        const submission = await result;
        assert.deepEqual(submission, {hash, blockHash});
        verifyRelayerReceipt(submission, {transactionHash:hash, blockHash});
        assert.throws(() => verifyRelayerReceipt(submission, {transactionHash:hash, blockHash:otherHash}));
      } else {
        const reason = {"nonce conflict":/NONCE_CONFLICT/, "different winner":/included replacement/, "external consumption":/REPLACED_EXTERNALLY/, "wrong network":/different task/}[scenario];
        await assert.rejects(result, reason);
      }
      assert.equal(sends,1);
      assert.equal(signs,1);
      assert.equal(reads,scenario === "nonce conflict" ? 0 : 1);
    });
  }
});
