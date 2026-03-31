// ============================================================
// JusticeLine - Main Client-Side Logic
// JWT-based authentication
// ============================================================

const API_BASE = '/api';

// ---- Dark Mode ----
const applyTheme = () => {
  const theme = localStorage.getItem('jl_theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('darkToggle');
  if (btn) btn.innerHTML = theme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
};

document.addEventListener('DOMContentLoaded', () => {
  applyTheme();

  // Dark mode toggle
  const darkToggle = document.getElementById('darkToggle');
  if (darkToggle) {
    darkToggle.addEventListener('click', () => {
      const current = localStorage.getItem('jl_theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('jl_theme', next);
      applyTheme();
    });
  }

  // Hamburger (mobile sidebar)
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (!sidebar.contains(e.target) && !hamburger.contains(e.target)) sidebar.classList.remove('open');
    });
  }

  // Dynamic navigation
  const userNav = document.getElementById('userNav');
  if (userNav) {
    const token = localStorage.getItem('jl_token');
    const name = localStorage.getItem('jl_name');
    if (token) {
      userNav.innerHTML = `
        <li><a href="index.html">Home</a></li>
        <li><a href="status.html">My Dashboard</a></li>
        <li><a href="submit.html">New Complaint</a></li>
        <li><a href="about.html">About</a></li>
        <li><a href="faq.html">FAQ</a></li>
        <li><a href="contact.html">Contact</a></li>
        <li><a href="#" onclick="logout()" style="color:var(--danger)"><i class="fa-solid fa-right-from-bracket"></i> Logout</a></li>
      `;
    } else {
      userNav.innerHTML = `
        <li><a href="index.html">Home</a></li>
        <li><a href="about.html">About</a></li>
        <li><a href="how-it-works.html">How It Works</a></li>
        <li><a href="faq.html">FAQ</a></li>
        <li><a href="contact.html">Contact</a></li>
        <li><a href="login.html" class="btn btn-outline btn-sm" style="margin-left:4px;">Login</a></li>
        <li><a href="register.html" class="btn btn-primary btn-sm">Register</a></li>
      `;
    }
  }

  // Active nav link highlighting
  const currentPage = window.location.pathname.split('/').pop();
  document.querySelectorAll('.site-header nav a, .sidebar-nav a').forEach(link => {
    if (link.getAttribute('href') === currentPage) link.classList.add('active');
  });

  // ---- REGISTER FORM ----
  const registerForm = document.getElementById('registerForm');
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('regBtn') || e.submitter;
      const msgEl = document.getElementById('regMsg');
      const msgText = document.getElementById('regMsgText');
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Creating account...';

      try {
        const res = await fetch(`${API_BASE}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('regName').value,
            phone: document.getElementById('regPhone').value,
            email: document.getElementById('regEmail').value,
            password: document.getElementById('regPass').value,
            address: document.getElementById('regAddress')?.value || ''
          })
        });
        const data = await res.json();
        if (res.ok) {
          msgEl.className = 'alert alert-success mb-2';
          msgText.innerHTML = '<strong>Account created!</strong> Redirecting to login...';
          setTimeout(() => window.location.href = 'login.html', 1500);
        } else {
          msgEl.className = 'alert alert-danger mb-2';
          msgText.textContent = data.error || 'Registration failed.';
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';
        }
      } catch {
        msgEl.className = 'alert alert-danger mb-2';
        msgText.textContent = 'Network error. Please try again.';
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-user-plus"></i> Create Account';
      }
    });
  }

  // ---- LOGIN FORM ----
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('loginBtn') || e.submitter;
      const msgEl = document.getElementById('loginMsg');
      const msgText = document.getElementById('loginMsgText');
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';

      try {
        const res = await fetch(`${API_BASE}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('loginEmail').value,
            password: document.getElementById('loginPass').value
          })
        });
        const data = await res.json();
        if (res.ok) {
          localStorage.setItem('jl_token', data.token);
          localStorage.setItem('jl_name', data.name);
          localStorage.setItem('jl_userId', data.userId);
          btn.innerHTML = '<i class="fa-solid fa-check"></i> Welcome back!';
          setTimeout(() => window.location.href = 'status.html', 800);
        } else {
          msgEl.className = 'alert alert-danger mb-2';
          msgText.textContent = data.error || 'Login failed.';
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
        }
      } catch {
        msgEl.className = 'alert alert-danger mb-2';
        msgText.textContent = 'Network error. Please try again.';
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
      }
    });
  }
});

// ---- LOGOUT ----
function logout() {
  localStorage.removeItem('jl_token');
  localStorage.removeItem('jl_name');
  localStorage.removeItem('jl_userId');
  window.location.href = 'login.html';
}

// ---- SOS / EMERGENCY ----
async function triggerSOS() {
  if (!confirm('⚠️ EMERGENCY ALERT: Send an emergency signal to authorities NOW?')) return;
  const name = prompt('Your name (optional):', 'Anonymous') || 'Anonymous';
  const phone = prompt('Your phone number (optional):', '') || 'Not provided';
  const details = prompt('Describe the emergency briefly:', 'Urgent help needed!') || 'SOS';
  let location = 'Not provided';
  const btn = document.getElementById('sosBtn');
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Sending SOS...</span>';
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { location = `GPS: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`; sendSOS(name, phone, location, details, btn); },
      () => sendSOS(name, phone, location, details, btn)
    );
  } else sendSOS(name, phone, location, details, btn);
}

async function sendSOS(name, phone, location, message, btn) {
  try {
    const res = await fetch('/api/help', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, location, message })
    });
    const data = await res.json();
    alert(`✅ ${data.message}`);
  } catch { alert('⚠️ Failed to send SOS. Please call 112 immediately!'); }
  finally { if (btn) btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> <span>EMERGENCY SOS</span>'; }
}
