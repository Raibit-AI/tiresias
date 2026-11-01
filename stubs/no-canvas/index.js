// SPDX-License-Identifier: Apache-2.0
// Tiresias never installs pdf.js's native canvas add-on (prebuilt machine code it does not need:
// it only extracts text). pdf.js loads the add-on inside try/catch and carries on without it.
throw new Error("@napi-rs/canvas is disabled in Tiresias");
