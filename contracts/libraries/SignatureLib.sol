// SPDX-License-Identifier: LicenseRef-GM-Wallet-Community-2.0
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library SignatureLib {
    function recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);

        if (error != ECDSA.RecoverError.NoError) {
            return address(0);
        }

        return signer;
    }

    function isValidSigner(
        bytes32 digest,
        bytes calldata signature,
        address expectedSigner
    ) internal pure returns (bool) {
        return recoverSigner(digest, signature) == expectedSigner;
    }
}
