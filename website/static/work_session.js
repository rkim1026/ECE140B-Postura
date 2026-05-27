document.addEventListener('DOMContentLoaded', () => {
  const timerValue = document.querySelector('.timer-value');
  const durationBtns = document.querySelectorAll('.dur-btn');
  const startBtn = document.querySelector('.timer-card .start-btn');
  const calibrateBtn = document.querySelector('.calibrate-btn');

  let selectedMinutes = 30;

  durationBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      durationBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedMinutes = parseInt(btn.textContent, 10);
      if (timerValue) timerValue.textContent = `${selectedMinutes}m`;
    });
  });

  document.querySelectorAll('.toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => toggle.classList.toggle('on'));
  });

  if (startBtn) {
    startBtn.addEventListener('click', () => {
      window.location.href = '/summary';
    });
  }

  if (calibrateBtn) {
    calibrateBtn.addEventListener('click', () => {
      calibrateBtn.disabled = true;
      calibrateBtn.textContent = 'Calibrating...';
      setTimeout(() => {
        calibrateBtn.disabled = false;
        calibrateBtn.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="6"/>
            <circle cx="12" cy="12" r="2"/>
          </svg>
          Calibrate Good Posture`;
        alert('Posture calibrated. You can start your session.');
      }, 1500);
    });
  }
});
