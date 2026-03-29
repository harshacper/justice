// main.js - Client Side Logic

const API_BASE = '/api';

document.addEventListener('DOMContentLoaded', () => {

    // Manage Navigation links based on login status
    const userNav = document.getElementById('userNav');
    if (userNav) {
        if (localStorage.getItem('userId')) {
            userNav.innerHTML = `
                <li><a href="index.html">Home</a></li>
                <li><a href="submit.html">New Complaint</a></li>
                <li><a href="status.html">My Status</a></li>
                <li><a href="about.html">About</a></li>
                <li><a href="how-it-works.html">How It Works</a></li>
                <li><a href="faq.html">FAQ</a></li>
                <li><a href="contact.html">Contact</a></li>
                <li><a href="#" onclick="logout()">Logout</a></li>
            `;
        } else {
            userNav.innerHTML = `
                <li><a href="index.html">Home</a></li>
                <li><a href="about.html">About</a></li>
                <li><a href="how-it-works.html">How It Works</a></li>
                <li><a href="faq.html">FAQ</a></li>
                <li><a href="contact.html">Contact</a></li>
                <li><a href="login.html">Login</a></li>
                <li><a href="register.html">Register</a></li>
                <li><a href="admin.html">Admin</a></li>
            `;
        }
    }

    // 1. User Registration
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                name: document.getElementById('regName').value,
                phone: document.getElementById('regPhone').value,
                email: document.getElementById('regEmail').value,
                password: document.getElementById('regPass').value,
                address: document.getElementById('regAddress').value
            };

            try {
                const res = await fetch(`${API_BASE}/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                const msgEl = document.getElementById('regMsg');

                if (res.ok) {
                    msgEl.style.color = '#38a169'; // success green
                    msgEl.innerText = "Registration successful! Redirecting to login...";
                    setTimeout(() => window.location.href = 'login.html', 1500);
                } else {
                    msgEl.style.color = '#e53e3e'; // error red
                    msgEl.innerText = data.error || "Registration failed.";
                }
            } catch (err) {
                document.getElementById('regMsg').innerText = "Server Error. Please try again later.";
            }
        });
    }

    // 2. User Login
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                email: document.getElementById('loginEmail').value,
                password: document.getElementById('loginPass').value
            };

            try {
                const res = await fetch(`${API_BASE}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                const msgEl = document.getElementById('loginMsg');

                if (res.ok) {
                    msgEl.style.color = '#38a169';
                    msgEl.innerText = "Processing secure login...";
                    localStorage.setItem('userId', data.userId);
                    localStorage.setItem('userName', data.name);
                    setTimeout(() => window.location.href = 'status.html', 1000);
                } else {
                    msgEl.style.color = '#e53e3e';
                    msgEl.innerText = data.error || "Invalid username or password.";
                }
            } catch (err) {
                document.getElementById('loginMsg').innerText = "System currently unreachable.";
            }
        });
    }

    // 3. Admin Login
    const adminLoginForm = document.getElementById('adminLoginForm');
    if (adminLoginForm) {
        adminLoginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                adminId: document.getElementById('adminId').value,
                password: document.getElementById('adminPass').value
            };

            try {
                const res = await fetch(`${API_BASE}/admin/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                const msgEl = document.getElementById('adminLoginMsg');

                if (res.ok) {
                    msgEl.style.color = '#38a169';
                    msgEl.innerText = "Authenticating privileges...";
                    localStorage.setItem('isAdmin', 'true');
                    setTimeout(() => window.location.reload(), 1000);
                } else {
                    msgEl.style.color = '#e53e3e';
                    msgEl.innerText = data.error || "Access Denied.";
                }
            } catch (err) {
                document.getElementById('adminLoginMsg').innerText = "Secure server unreachable.";
            }
        });
    }

    // 4. Submit Complaint
    const btnFinalSubmit = document.getElementById('btnFinalSubmit');
    if (btnFinalSubmit) {
        btnFinalSubmit.addEventListener('click', async () => {
            // Hide confirmation modal
            document.getElementById('confirmModal').style.display = 'none';

            const formData = new FormData();
            formData.append('userId', localStorage.getItem('userId'));
            formData.append('title', document.getElementById('compTitle').value);
            formData.append('date', document.getElementById('compDate').value);
            formData.append('description', document.getElementById('compDesc').value);
            formData.append('category', document.getElementById('compCategory').value);
            formData.append('priority', document.getElementById('compPriority').value);
            formData.append('location', document.getElementById('compLocation').value);

            const fileInput = document.getElementById('compImage');
            if (fileInput.files.length > 0) {
                formData.append('image', fileInput.files[0]);
            }

            try {
                const res = await fetch(`${API_BASE}/complaints`, {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();
                if (res.ok) {
                    document.getElementById('successModal').style.display = 'flex';
                    document.getElementById('complaintForm').reset();
                } else {
                    alert('Error: ' + data.error);
                }
            } catch (err) {
                alert('Submission failed. Check network link.');
            }
        });
    }
});

function logout() {
    localStorage.removeItem('userId');
    localStorage.removeItem('userName');
    window.location.href = 'login.html';
}
