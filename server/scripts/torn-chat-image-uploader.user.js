// ==UserScript==
// @name         Torn Chat Image Uploader (ImgBB) (tornwar fork)
// @namespace    tornwar.com
// @version      1.4-wb1
// @description  Upload images to ImgBB via Torn chat (select or paste) and paste link automatically. Fork of dingus [3188789]'s v1.4 with hash-agnostic selectors so it survives Torn frontend rebundles.
// @author       dingus [3188789] (fork by RussianRob)
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.imgbb.com
// @license      MIT
// @downloadURL  https://tornwar.com/scripts/torn-chat-image-uploader.user.js
// @updateURL    https://tornwar.com/scripts/torn-chat-image-uploader.meta.js
// ==/UserScript==
//
// =============================================================================
// CHANGELOG (tornwar fork)
// =============================================================================
// 1.4-wb1 — Replaced literal `div[class*="root___WUd1h"]` (which broke the
//           next time Torn rebundled and regenerated CSS-module hashes)
//           with a hash-agnostic check: any div whose class contains
//           `root___`. Dedupes nested wrappers by walking up from each
//           textarea on the page to the nearest `root___` ancestor —
//           that's the same wrapper the upstream pinned, just without
//           the hash. Same survive-future-rebundles pattern as the other
//           tornwar forks (arson-bang-for-buck, torn-hide-crimes-stories).
//
//           API key (`@connect api.imgbb.com`) supports per-user override
//           via Tampermonkey's GM_setValue('imgbb_api_key', '...'). If
//           unset, falls back to the upstream's baked-in key — which
//           shares quota with everyone using the original. To set your
//           own:  in browser console on torn.com run
//             GM_setValue && GM_setValue('imgbb_api_key', 'YOUR_KEY_HERE')
//           (or use Tampermonkey's storage editor on the script).
// =============================================================================

(function() {
    'use strict';

    // Upstream's key — public on greasyfork, free-tier shared quota.
    // Per-user override via GM_setValue('imgbb_api_key', ...).
    const DEFAULT_IMGBB_API_KEY = '2d71dd2ec21a48c6e634aeb6ec0544dd';
    function getApiKey() {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue('imgbb_api_key', DEFAULT_IMGBB_API_KEY);
            }
        } catch (_) {}
        return DEFAULT_IMGBB_API_KEY;
    }

    function uploadImage(file, chatInput) {
        const key = getApiKey();
        if (!key) {
            alert("ImgBB API Key is missing. Please add a valid key to the script.");
            return;
        }

        const formData = new FormData();
        formData.append('image', file);

        const originalPlaceholder = chatInput.placeholder;
        chatInput.placeholder = "Uploading...";
        chatInput.disabled = true;

        GM_xmlhttpRequest({
            method: "POST",
            url: `https://api.imgbb.com/1/upload?key=${key}`,
            data: formData,
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.success) {
                        const url = data.data.url;
                        const currentValue = chatInput.value;
                        chatInput.value = currentValue ? currentValue + " " + url : url;
                        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                        chatInput.focus();
                    } else {
                        alert("Upload failed: " + (data.error ? data.error.message : "Unknown error"));
                    }
                } catch (e) {
                    alert("Error parsing ImgBB response.");
                }
                chatInput.placeholder = originalPlaceholder;
                chatInput.disabled = false;
            },
            onerror: function() {
                alert("Network error.");
                chatInput.placeholder = originalPlaceholder;
                chatInput.disabled = false;
            }
        });
    }

    function handlePaste(e, chatInput) {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image") !== -1) {
                const blob = items[i].getAsFile();
                uploadImage(blob, chatInput);
            }
        }
    }

    function injectUploadButton() {
        // wb1: hash-agnostic. Walk every textarea on the page and find
        // its nearest `div[class*="root___"]` ancestor — that's the same
        // wrapper the upstream pinned via `root___WUd1h`, but without
        // the hash that rotates on every Torn rebundle. Set dedupes
        // wrappers that contain multiple textareas (shouldn't happen
        // for chat, but defensive).
        const wrappers = new Set();
        for (const ta of document.querySelectorAll('textarea')) {
            const w = ta.closest('div[class*="root___"]');
            if (w) wrappers.add(w);
        }

        wrappers.forEach(wrapper => {
            const chatInput = wrapper.querySelector('textarea');
            if (!chatInput) return;

            if (!chatInput.dataset.pasteListener) {
                chatInput.addEventListener('paste', (e) => handlePaste(e, chatInput));
                chatInput.dataset.pasteListener = "true";
            }

            if (wrapper.querySelector('.imgbb-native-trigger')) return;

            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.style.display = 'none';
            fileInput.onchange = (e) => {
                if (e.target.files[0]) uploadImage(e.target.files[0], chatInput);
            };

            const uploadBtn = document.createElement('div');
            uploadBtn.className = 'imgbb-native-trigger';
            uploadBtn.title = 'Upload Image';

            uploadBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="16" height="16">
                    <path fill="currentColor" d="M149.1 64.8L138.7 96H64C28.7 96 0 124.7 0 160V416c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V160c0-35.3-28.7-64-64-64H373.3L362.9 64.8C356.4 45.2 338.1 32 317.4 32H194.6c-20.7 0-39 13.2-45.5 32.8zM256 192a96 96 0 1 1 0 192 96 96 0 1 1 0-192z"/>
                </svg>
            `;

            uploadBtn.style = `
                cursor: pointer;
                padding: 4px 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #aaa;
                transition: color 0.2s;
            `;

            uploadBtn.onmouseover = () => { uploadBtn.style.color = '#378ad3'; };
            uploadBtn.onmouseout = () => { uploadBtn.style.color = '#aaa'; };

            uploadBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                fileInput.click();
            };

            wrapper.prepend(fileInput);
            wrapper.prepend(uploadBtn);
        });
    }

    setInterval(injectUploadButton, 2000);
})();
