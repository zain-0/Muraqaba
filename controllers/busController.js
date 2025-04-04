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



import User from '../models/User.js'; // make sure this import exists

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
      vendorId, // selected vendor passed in body
    } = req.body;

    // Validate vendor
    const vendorUser = await User.findById(vendorId);
    if (!vendorUser) {
      return res.status(404).json({ message: 'Vendor not found' });
    }

    // Validate nested parts
    const parts = { engine, ac, tyre, transmission, brakePad };
    for (const [key, value] of Object.entries(parts)) {
      if (!value || typeof value.serviceKm !== 'number' || typeof value.currentKm !== 'number') {
        return res.status(400).json({
          message: `Missing or invalid serviceKm/currentKm in ${key}`,
        });
      }
    }

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
      vendor: vendorUser._id,
    });

    await newBus.save();

    res.status(201).json({
      message: 'Bus created successfully',
      bus: newBus,
    });
  } catch (err) {
    console.error(err);
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(409).json({ message: `Duplicate value for ${field}` });
    }
    res.status(500).json({ message: 'Server error' });
  }
};
