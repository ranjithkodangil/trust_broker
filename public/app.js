document.addEventListener('DOMContentLoaded', () => {
    // Key Generator elements
    const newKidInput = document.getElementById('new-kid');
    const newExpiryInput = document.getElementById('new-expiry');
    const createKeyBtn = document.getElementById('create-key-btn');

    // Key Explorer elements
    const lookupKidInput = document.getElementById('lookup-kid');
    const lookupBtn = document.getElementById('lookup-btn');
    const jwkDisplay = document.getElementById('jwk-display');

    // Token Issuer elements
    const issuingKidInput = document.getElementById('issuing-kid');
    const payloadInput = document.getElementById('payload-input');
    const issueBtn = document.getElementById('issue-btn');
    const tokenResult = document.getElementById('token-result');
    const tokenDisplay = document.getElementById('token-display');
    const jwtIoLink = document.getElementById('jwt-io-link');

    let availableKids = [];
    const kidSuggestions = document.getElementById('kid-suggestions');

    // --- Key Generation ---
    async function createKey() {
        const kid = newKidInput.value.trim();
        const expiration_time = newExpiryInput.value.trim();
        const audience = document.getElementById('new-audience').value.trim();

        if (!kid || !expiration_time || !audience) {
            showToast('Please provide Key ID, Expiration Time, and Audience', 'error');
            return;
        }

        createKeyBtn.disabled = true;
        createKeyBtn.textContent = 'Generating...';

        try {
            const response = await fetch('/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kid, expiration_time, audience })
            });

            const data = await response.json();

            if (response.ok) {
                showToast('Key generated and saved successfully!', 'success');
                // Automatically fill the lookup and issuer fields
                lookupKidInput.value = kid;
                issuingKidInput.value = kid;
                updateIssueButtonState();
                fetchAvailableKids(); // Refresh autocomplete list
                lookupKey(); // Refresh explorer
            } else {
                showToast('Error: ' + (data.error || 'Failed to create key'), 'error');
            }
        } catch (err) {
            showToast('Request failed: ' + err.message, 'error');
        } finally {
            createKeyBtn.disabled = false;
            createKeyBtn.textContent = 'Create & Save';
        }
    }

    // --- Key Lookup ---
    async function lookupKey() {
        const id = lookupKidInput.value.trim();
        if (!id) return;

        jwkDisplay.textContent = 'Fetching JWK...';

        try {
            const response = await fetch(`/.well-known/jwk?id=${encodeURIComponent(id)}`);
            const data = await response.json();

            if (response.ok) {
                jwkDisplay.textContent = JSON.stringify(data, null, 2);
                // Sync with issuing kid for convenience
                issuingKidInput.value = id;
                updateIssueButtonState();
                showToast(`Key '${id}' found!`, 'success');
            } else {
                jwkDisplay.textContent = `Error: ${data.error || 'Key not found'}`;
                showToast(data.error || 'Key not found', 'error');
            }
        } catch (err) {
            jwkDisplay.textContent = 'Request failed: ' + err.message;
        }
    }

    // --- Issue Token ---
    async function issueToken() {
        const kid = issuingKidInput.value.trim();
        if (!kid) {
            showToast('Please specify a Key ID (kid) to sign with.', 'error');
            return;
        }

        issueBtn.disabled = true;
        issueBtn.textContent = 'Generating...';

        try {
            let payloadText = payloadInput.value.trim();
            if (!payloadText) {
                showToast('Please provide a JSON payload.', 'error');
                return;
            }

            let payload;
            try {
                payload = JSON.parse(payloadText);
            } catch (e) {
                showToast('Invalid JSON payload: ' + e.message, 'error');
                return;
            }

            if (Object.keys(payload).length === 0) {
                showToast('Payload cannot be an empty object.', 'error');
                return;
            }

            const response = await fetch('/issue-token', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-key-id': kid
                },
                body: JSON.stringify({ payload })
            });

            const data = await response.json();
            
            if (response.ok && data.token) {
                tokenDisplay.textContent = data.token;
                tokenResult.classList.remove('hidden');
                jwtIoLink.href = `https://jwt.io/#debugger-io?token=${data.token}`;
                showToast('JWT issued successfully!', 'success');
            } else {
                showToast('Error: ' + (data.error || 'Unknown error'), 'error');
            }
        } catch (err) {
            showToast('Request failed: ' + err.message, 'error');
        } finally {
            issueBtn.disabled = false;
            issueBtn.textContent = 'Generate Signed JWT';
        }
    }

    // --- Utils ---
    function showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        
        const icons = {
            success: '✅',
            error: '❌',
            info: 'ℹ️'
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
            <span class="toast-message">${message}</span>
        `;

        container.appendChild(toast);

        // Auto remove
        setTimeout(() => {
            toast.classList.add('removing');
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 4000);
    }

    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const text = document.getElementById(targetId).textContent;
            navigator.clipboard.writeText(text).then(() => {
                const originalText = btn.textContent;
                btn.textContent = 'Copied!';
                btn.classList.add('success');
                setTimeout(() => {
                    btn.textContent = originalText;
                    btn.classList.remove('success');
                }, 2000);
            });
        });
    });

    // --- Button State Management ---
    function updateIssueButtonState() {
        const kid = issuingKidInput.value.trim();
        const payload = payloadInput.value.trim();
        issueBtn.disabled = !(kid && payload);
    }

    // --- Autocomplete Logic ---
    let activeDropdown = null;

    async function fetchAvailableKids() {
        try {
            const response = await fetch('/keys/list');
            if (response.ok) {
                availableKids = await response.json();
                console.log('Available keys for autocomplete:', availableKids);
            }
        } catch (err) {
            console.error('Failed to fetch keys for autocomplete:', err);
        }
    }

    function setupCustomAutocomplete(input) {
        const wrapper = input.parentElement;
        const dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown';
        wrapper.appendChild(dropdown);

        let activeIndex = -1;
        let currentSuggestions = [];

        function renderSuggestions(suggestions) {
            currentSuggestions = suggestions;
            if (suggestions.length === 0) {
                dropdown.classList.remove('show');
                return;
            }

            dropdown.innerHTML = suggestions
                .map((s, i) => `<div class="autocomplete-item ${i === activeIndex ? 'active' : ''}" data-index="${i}">${s}</div>`)
                .join('');
            dropdown.classList.add('show');
            activeDropdown = dropdown;
        }

        input.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            activeIndex = -1;
            
            updateIssueButtonState();

            if (val.length >= 5) {
                const matches = availableKids.filter(k => k.toLowerCase().includes(val.toLowerCase()));
                renderSuggestions(matches);
            } else {
                renderSuggestions([]);
            }
        });

        input.addEventListener('keydown', (e) => {
            if (!dropdown.classList.contains('show')) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeIndex = (activeIndex + 1) % currentSuggestions.length;
                renderSuggestions(currentSuggestions);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeIndex = (activeIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
                renderSuggestions(currentSuggestions);
            } else if (e.key === 'Enter') {
                if (activeIndex > -1) {
                    e.preventDefault();
                    selectItem(currentSuggestions[activeIndex]);
                }
            } else if (e.key === 'Escape') {
                renderSuggestions([]);
            }
        });

        dropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.autocomplete-item');
            if (item) {
                const index = parseInt(item.dataset.index);
                selectItem(currentSuggestions[index]);
            }
        });

        function selectItem(val) {
            input.value = val;
            renderSuggestions([]);
            updateIssueButtonState();
            // Trigger lookup automatically if it's the explorer field
            if (input.id === 'lookup-kid') lookupKey();
        }
    }

    function setupCustomSelect(selectId) {
        const select = document.getElementById(selectId);
        if (!select) return;

        const trigger = select.querySelector('.select-trigger');
        const options = select.querySelectorAll('.select-option');
        const hiddenInput = select.querySelector('input[type="hidden"]');

        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Close other selects if any
            document.querySelectorAll('.custom-select').forEach(s => {
                if (s !== select) s.classList.remove('open');
            });
            
            select.classList.toggle('open');
        });

        options.forEach(opt => {
            opt.addEventListener('click', () => {
                const val = opt.dataset.value;
                const text = opt.textContent;

                trigger.textContent = text;
                hiddenInput.value = val;

                options.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                select.classList.remove('open');
            });
        });

        document.addEventListener('click', (e) => {
            if (!select.contains(e.target)) {
                select.classList.remove('open');
            }
        });
    }

    // Initialize custom select
    setupCustomSelect('new-expiry-select');

    // Initialize custom autocompletes
    setupCustomAutocomplete(issuingKidInput);
    setupCustomAutocomplete(lookupKidInput);

    // Close dropdowns on outside click (Autocomplete and general)
    document.addEventListener('click', (e) => {
        if (activeDropdown && !e.target.closest('.autocomplete-wrapper')) {
            activeDropdown.classList.remove('show');
            activeDropdown = null;
        }
    });

    payloadInput.addEventListener('input', updateIssueButtonState);

    // Initial check on load
    updateIssueButtonState();
    fetchAvailableKids();

    createKeyBtn.addEventListener('click', createKey);
    lookupBtn.addEventListener('click', lookupKey);
    issueBtn.addEventListener('click', issueToken);

    // Enter key support for lookup
    lookupKidInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !activeDropdown?.classList.contains('show')) {
            lookupKey();
        }
    });
});
