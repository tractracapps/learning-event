const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    date: {
      type: String,
      default: ''
    },

    location: {
      type: String,
      default: '',
      trim: true
    },

    capacity: {
      type: Number,
      required: true,
      default: 170,
      min: 1
    },

    status: {
      type: String,
      enum: ['draft', 'active', 'closed', 'archived'],
      default: 'draft'
    }
  },
  {
    timestamps: true
  }
);

module.exports =
  mongoose.models.Event ||
  mongoose.model('Event', eventSchema);