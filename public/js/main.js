// إصلاح فوري لمشاكل الواجهة
function fixUI() {
    console.log('🔧 بدء إصلاح الواجهة...');
    
    // إصلاح جميع العناصر
    const allElements = document.querySelectorAll('*');
    allElements.forEach(element => {
        element.style.opacity = '1';
        element.style.filter = 'none';
        element.style.webkitFilter = 'none';
        element.style.backdropFilter = 'none';
        element.style.webkitBackdropFilter = 'none';
        element.style.visibility = 'visible';
    });
    
    // إصلاح النصوص
    const texts = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, a, button, input, textarea, select, label');
    texts.forEach(text => {
        text.style.color = '#ffffff';
        text.style.opacity = '1';
    });
    
    // إصلاح الخلفيات
    const backgrounds = document.querySelectorAll('.card, .modal, .btn, .form-control, .form-select, .modal-container, .modal-content');
    backgrounds.forEach(bg => {
        bg.style.backgroundColor = '#1a1a1a';
        bg.style.opacity = '1';
    });
    
    // إصلاح الأزرار
    const buttons = document.querySelectorAll('.btn-primary');
    buttons.forEach(btn => {
        btn.style.backgroundColor = '#dc2626';
        btn.style.color = '#ffffff';
        btn.style.opacity = '1';
    });
    
    const secButtons = document.querySelectorAll('.btn-secondary');
    secButtons.forEach(btn => {
        btn.style.backgroundColor = '#2a2a2a';
        btn.style.color = '#ffffff';
        btn.style.opacity = '1';
    });
    
    // إصلاح النماذج
    const inputs = document.querySelectorAll('input, textarea, select');
    inputs.forEach(input => {
        input.style.backgroundColor = '#2a2a2a';
        input.style.color = '#ffffff';
        input.style.border = '1px solid #333333';
        input.style.opacity = '1';
    });
    
    console.log('✅ تم إصلاح الواجهة');
}

// تشغيل الإصلاح فوراً
fixUI();

// تشغيل الإصلاح عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', function() {
    fixUI();
    
    // تشغيل الإصلاح كل ثانية
    setInterval(fixUI, 1000);
    // Mobile navigation toggle
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');
    const navOverlay = document.getElementById('navOverlay');
    
    if (navToggle && navMenu) {
        const closeMenu = () => {
            navMenu.classList.remove('open');
            if (navOverlay) navOverlay.classList.remove('open');
            navToggle.setAttribute('aria-expanded', 'false');
        };
        const openMenu = () => {
            navMenu.classList.add('open');
            if (navOverlay) navOverlay.classList.add('open');
            navToggle.setAttribute('aria-expanded', 'true');
        };
        navToggle.addEventListener('click', () => {
            if (navMenu.classList.contains('open')) closeMenu(); else openMenu();
        });
        if (navOverlay) navOverlay.addEventListener('click', closeMenu);
        window.addEventListener('resize', () => {
            if (window.innerWidth > 991) closeMenu();
        });
    }
    // Card spotlight effect
    document.querySelectorAll('.card').forEach(card => {
        card.addEventListener('mousemove', (e) => {
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--x', (e.clientX - rect.left) + 'px');
            card.style.setProperty('--y', (e.clientY - rect.top) + 'px');
        });
    });

    // Tab navigation
    const tabItems = document.querySelectorAll('.tab-item');
    if (tabItems.length > 0) {
        tabItems.forEach(tab => {
            tab.addEventListener('click', function() {
                const tabId = this.getAttribute('data-tab');
                
                // Remove active class from all tabs and panes
                document.querySelectorAll('.tab-item').forEach(item => item.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
                
                // Add active class to current tab and pane
                this.classList.add('active');
                document.getElementById(tabId).classList.add('active');
                
                // Load logs if logs tab is clicked
                if (tabId === 'logs' && typeof loadLogs === 'function') {
                    loadLogs();
                }
            });
        });
    }

    // Removed: server-info fetcher (IP exposure disabled)
        
        // Console page functionality
        if (document.getElementById('console-output') && !window.__consoleInit) {
            const consoleOutput = document.getElementById('console-output');
            const commandInput = document.getElementById('command-input');
        const sendCommand = document.getElementById('send-command');
        const clearConsole = document.getElementById('clear-console');
        const hostId = consoleOutput.getAttribute('data-host-id');
        
        let socket = io();
        
        // Connect to socket.io for real-time console updates
        socket.on('connect', function() {
            console.log('Connected to socket.io server');
            socket.emit('join-console', hostId);
        });
        
        socket.on('console-output', function(message) {
            const line = document.createElement('div');
            line.className = 'console-line';
            line.textContent = typeof message === 'string' ? message : (message && message.message) || '';
            consoleOutput.appendChild(line);
            consoleOutput.scrollTop = consoleOutput.scrollHeight;
        });
        
        // Load initial console output
        fetch(`/api/hosting/${hostId}/logs`)
            .then(response => response.json())
            .then(data => {
                if (data.success && Array.isArray(data.logs)) {
                consoleOutput.innerHTML = '';
                    data.logs.forEach(line => {
                        const lineEl = document.createElement('div');
                        lineEl.className = 'console-line';
                        lineEl.textContent = line;
                        consoleOutput.appendChild(lineEl);
                    });
                    consoleOutput.scrollTop = consoleOutput.scrollHeight;
                        } else {
                    consoleOutput.innerHTML = '<div class="console-line text-danger">فشل في تحميل مخرجات وحدة التحكم</div>';
                }
            })
            .catch(err => {
                consoleOutput.innerHTML = '<div class="console-line text-danger">خطأ في الاتصال</div>';
            });
        
        // Send command
        function sendConsoleCommand() {
            if (commandInput.value.trim() === '') return;
            
            const command = commandInput.value;
            commandInput.value = '';
            
            const line = document.createElement('div');
            line.className = 'console-line console-command';
            line.textContent = '> ' + command;
            consoleOutput.appendChild(line);
            consoleOutput.scrollTop = consoleOutput.scrollHeight;
            
            fetch(`/api/hosting/${hostId}/command`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ command })
            })
            .catch(err => {
                const errorLine = document.createElement('div');
                errorLine.className = 'console-line text-danger';
                errorLine.textContent = 'خطأ في إرسال الأمر';
                consoleOutput.appendChild(errorLine);
                consoleOutput.scrollTop = consoleOutput.scrollHeight;
            });
        }
        
        if (sendCommand) {
            sendCommand.addEventListener('click', sendConsoleCommand);
        }
        
        if (commandInput) {
            commandInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    sendConsoleCommand();
                    }
                });
            }
            
        if (clearConsole) {
            clearConsole.addEventListener('click', function() {
                consoleOutput.innerHTML = '';
                try { localStorage.removeItem(`console_logs_${hostId}`); } catch (e) {}
            });
        }
    }
});

// Toast notification function
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-content">
            <i class="fas ${type === 'success' ? 'fa-check-circle' : type === 'info' ? 'fa-info-circle' : 'fa-exclamation-circle'}"></i>
            <span>${message}</span>
        </div>
        <div class="toast-progress"></div>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 3000);
}

// Copy to clipboard helper
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('تم نسخ النص إلى الحافظة', 'success');
    }).catch(err => {
        console.error('Failed to copy text: ', err);
        showToast('فشل في نسخ النص', 'error');
    });
}

// Loading spinner
let spinnerCount = 0;
const spinner = document.createElement('div');
spinner.className = 'global-spinner';
spinner.innerHTML = '<div class="spinner"></div>';

function showSpinner() {
    if (spinnerCount === 0) {
        document.body.appendChild(spinner);
        document.body.classList.add('loading');
    }
    spinnerCount++;
}

function hideSpinner() {
    spinnerCount = Math.max(0, spinnerCount - 1);
    if (spinnerCount === 0) {
        document.body.classList.remove('loading');
        if (spinner.parentNode) {
            spinner.parentNode.removeChild(spinner);
        }
    }
}

// Add these styles to the document
(function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
        .global-spinner {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 9999;
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: var(--accent-blue);
            animation: spin 1s ease-in-out infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        body.loading {
            overflow: hidden;
        }
        
        .toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background-color: var(--bg-med);
            border-radius: var(--radius);
            box-shadow: var(--shadow-md);
            padding: 12px 16px;
            display: flex;
            flex-direction: column;
            min-width: 300px;
            transform: translateY(0);
            opacity: 1;
            transition: transform 0.3s ease, opacity 0.3s ease;
            z-index: 1000;
        }
        
        .toast.show {
            transform: translateY(0);
            opacity: 1;
        }
        
        .toast.success {
            border-left: 4px solid var(--accent-green);
        }
        
        .toast.error {
            border-left: 4px solid var(--accent-red);
        }
        
        .toast-content {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .toast-content i {
            font-size: 20px;
        }
        
        .toast.success i {
            color: var(--accent-green);
        }
        
        .toast.error i {
            color: var(--accent-red);
        }
        
        .toast-progress {
            height: 3px;
            background-color: var(--accent-blue);
            margin-top: 8px;
            animation: toast-progress 3s linear forwards;
        }
        
        @keyframes toast-progress {
            to { width: 0%; }
            from { width: 100%; }
        }

        /* Modal styles */
        .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2147483000;
        }
        .modal {
            background: var(--bg-med);
            border-radius: var(--radius);
            box-shadow: var(--shadow-lg);
            width: 420px;
            max-width: 95vw;
            overflow: hidden;
            pointer-events: auto;
        }
        .modal-header, .modal-footer {
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            border-bottom: 1px solid var(--bg-dark);
        }
        .modal-footer { border-top: 1px solid var(--bg-dark); border-bottom: none; }
        .modal-body { padding: 16px; }
        .modal-overlay * { pointer-events: auto; }
    `;
    document.head.appendChild(style);
})();