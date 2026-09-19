process.on('message', () => {
  // Deliberately never reply. The parent must terminate this process at the deadline.
});
