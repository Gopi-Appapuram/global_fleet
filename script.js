// Function to handle shipment tracking
function trackShipment() {
    const trackingNumber = document.getElementById('tracking-number').value;
    if (trackingNumber) {
      alert(`Tracking information for: ${trackingNumber}`);
      // Add real tracking functionality here
    } else {
      alert('Please enter a tracking number.');
    }
  }
  
  // Function to handle form submission for quote request
  document.getElementById('quote-form').addEventListener('submit', function(event) {
    event.preventDefault();
    alert('Quote request submitted!');
  });
  
  // Function to handle form submission for contact
  document.getElementById('contact-form').addEventListener('submit', function(event) {
    event.preventDefault();
    alert('Message sent!');
  });
  