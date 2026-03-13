const { Command } = require("commander");
const { ensureConfig } = require("../../lib/config");

function createRateCommand() {
  const command = new Command("rate")
    .description("Rate a completed task")
    .argument("<task-id>", "Task ID to rate")
    .requiredOption("--stars <rating>", "Rating from 1 to 5")
    .option("--comment <text>", "Optional review comment")
    .action(async (taskId, options) => {
      const config = ensureConfig();
      const serverUrl = config.server_url || "http://localhost:7070";
      const apiKey = config.api_key;

      if (!apiKey) {
        console.error("Not registered. Run 'tachi register' first.");
        process.exitCode = 1;
        return;
      }

      const rating = parseInt(options.stars, 10);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        console.error("Rating must be an integer between 1 and 5.");
        process.exitCode = 1;
        return;
      }

      const body = { rating };
      if (options.comment) {
        body.comment = options.comment;
      }

      try {
        const response = await fetch(`${serverUrl}/tasks/${taskId}/rate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
          },
          body: JSON.stringify(body),
        });

        const data = await response.json();

        if (!response.ok) {
          console.error(data.error || "Rating failed");
          process.exitCode = 1;
          return;
        }

        console.log(`Rated task ${taskId}: ${rating}/5`);
        if (data.comment) {
          console.log(`Comment: ${data.comment}`);
        }
        console.log(`Reviewee rating: ${data.reviewee_rating.avg} avg (${data.reviewee_rating.count} reviews)`);
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
      }
    });

  return command;
}

module.exports = { createRateCommand };
