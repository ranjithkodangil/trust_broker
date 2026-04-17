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

    // --- Key Generation ---
    async function createKey() {
        const kid = newKidInput.value.trim();
        const expiration_time = newExpiryInput.value.trim();
        const audience = document.getElementById('new-audience').value.trim();

        if (!kid || !expiration_time || !audience) {
            alert('Please provide Key ID, Expiration Time, and Audience');
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
                alert('Key generated and saved successfully!');
                // Automatically fill the lookup and issuer fields
                lookupKidInput.value = kid;
                issuingKidInput.value = kid;
                lookupKey(); // Refresh explorer
            } else {
                alert('Error: ' + (data.error || 'Failed to create key'));
            }
        } catch (err) {
            alert('Request failed: ' + err.message);
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
            } else {
                jwkDisplay.textContent = `Error: ${data.error || 'Key not found'}`;
            }
        } catch (err) {
            jwkDisplay.textContent = 'Request failed: ' + err.message;
        }
    }

    // --- Issue Token ---
    async function issueToken() {
        const kid = issuingKidInput.value.trim();
        if (!kid) {
            alert('Please specify a Key ID (kid) to sign with.');
            return;
        }

        issueBtn.disabled = true;
        issueBtn.textContent = 'Generating...';

        try {
            let payload;
            try {
                payload = JSON.parse(payloadInput.value);
            } catch (e) {
                alert('Invalid JSON payload');
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
            } else {
                alert('Error: ' + (data.error || 'Unknown error'));
            }
        } catch (err) {
            alert('Request failed: ' + err.message);
        } finally {
            issueBtn.disabled = false;
            issueBtn.textContent = 'Generate Signed JWT';
        }
    }

    // --- Utils ---
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

    createKeyBtn.addEventListener('click', createKey);
    lookupBtn.addEventListener('click', lookupKey);
    issueBtn.addEventListener('click', issueToken);

    // Enter key support for lookup
    lookupKidInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') lookupKey();
    });
});
