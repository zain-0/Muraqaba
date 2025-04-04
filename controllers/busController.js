import Bus from '../models/Bus.js'; // Adjust the path as necessary

// Controller to get all buses
export const getAllBuses = async (req, res) => {
    try {
        const buses = await Bus.find(); // Fetch all buses from the database
        res.status(200).json(buses); // Return the buses as a JSON response
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Controller to get a single bus by ID
export const getBusById = async (req, res) => {
    try {
        const bus = await Bus.findById(req.params.id); // Find the bus by ID
        if (!bus) {
            return res.status(404).json({ message: 'Bus not found' });
        }
        res.status(200).json(bus); // Return the bus as a JSON response
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};



export const createBus = async (req, res) => {
  try {
    const {
      chassisNumber,
      fleetNumber,
      registrationNumber,
      make,
      model,
      year,
      engine,
      ac,
      tyre,
      transmission,
      brakePad,
    } = req.body;

    // Validate all required nested fields
    const requiredNestedFields = [engine, ac, tyre, transmission, brakePad];
    const names = ['engine', 'ac', 'tyre', 'transmission', 'brakePad'];

    for (let i = 0; i < requiredNestedFields.length; i++) {
      const part = requiredNestedFields[i];
      if (
        !part ||
        typeof part.serviceKm !== 'number' ||
        typeof part.currentKm !== 'number'
      ) {
        return res.status(400).json({
          message: `Invalid or missing fields in ${names[i]} (must include numeric serviceKm and currentKm).`,
        });
      }
    }

    // Create a new Bus document
    const newBus = new Bus({
      chassisNumber,
      fleetNumber,
      registrationNumber,
      make,
      model,
      year,
      engine,
      ac,
      tyre,
      transmission,
      brakePad,
    });

    // Save to DB
    await newBus.save();

    res.status(201).json({
      message: 'Bus created successfully',
      bus: newBus,
    });
  } catch (err) {
    console.error(err);

    // Duplicate entry handling
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(409).json({ message: `Duplicate value for ${field}` });
    }

    res.status(500).json({ message: 'Server error' });
  }
};
