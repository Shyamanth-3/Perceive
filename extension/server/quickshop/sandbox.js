document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const checkoutForm = document.getElementById('checkout-form');
    const loginSection = document.getElementById('login-section');
    const checkoutSection = document.getElementById('checkout-section');
    const confirmationSection = document.getElementById('confirmation-section');

    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // In a real app we'd validate here. For demo, just transition.
        loginSection.classList.add('hidden');
        checkoutSection.classList.remove('hidden');
    });

    checkoutForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Transition to confirmation
        checkoutSection.classList.add('hidden');
        confirmationSection.classList.remove('hidden');
    });
});
